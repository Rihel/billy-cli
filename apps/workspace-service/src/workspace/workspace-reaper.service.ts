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
    // 进程刚起来时内存里没有任何 handle：先把还在跑的容器认领回来，再开始定时回收。
    // 不认领的话它们永远不进 handles，也就永远扫不到（见 WorkspaceRuntime.reconcile）。
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
