import type { OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common'
import { Inject, Injectable } from '@nestjs/common'
import { AppLogger } from '@repo/kits'
import { WorkspaceServiceConfig, type WorkspaceServiceConfigValue } from '../config/app-config.js'
import { WorkspaceRuntime } from './workspace-runtime.service.js'

/**
 * 空闲回收：每 `reapIntervalMs` 扫一遍，超过 `idleTimeoutMs` 的容器停掉。
 *
 * 这是**实际状态变化**，不回写 `desired_status`（方案 B）；用户下次执行时 `ensure` 重新拉起。
 */
@Injectable()
export class WorkspaceReaper implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer?: NodeJS.Timeout

  constructor(
    @Inject(WorkspaceRuntime) private readonly runtime: WorkspaceRuntime,
    @Inject(WorkspaceServiceConfig) private readonly config: WorkspaceServiceConfigValue,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}

  onApplicationBootstrap(): void {
    // 单副本：进程刚起来时内存里没有任何 handle，先把还在跑的容器认领回来再定时回收。
    // 多副本不认领全量（每个 Pod 各存一份没意义）：回收器直接按 DB 列表 + Redis lastUsed 扫。
    if (this.runtime.isDistributed()) {
      this.logger.info('workspace.reaper.distributed', {
        reason: '多副本：回收器按 DB 列表 + Redis lastUsed 扫描，不做全量认领',
      })
    } else {
      void this.runtime.reconcile().then(
        (count) => {
          if (count > 0) this.logger.info('workspace.reconcile.adopted', { count })
        },
        (error: unknown) => {
          this.logger.warn('workspace.reconcile.failed', {
            reason: error instanceof Error ? error.message : String(error),
          })
        },
      )
    }
    this.timer = setInterval(() => {
      void this.runtime.reapIdle().then(
        (count) => {
          if (count > 0) this.logger.info('workspace.reaper.swept', { count })
        },
        (error: unknown) => {
          this.logger.warn('workspace.reaper.failed', {
            reason: error instanceof Error ? error.message : String(error),
          })
        },
      )
    }, this.config.reapIntervalMs)
    this.timer.unref?.()
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer)
  }
}
