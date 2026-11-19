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
