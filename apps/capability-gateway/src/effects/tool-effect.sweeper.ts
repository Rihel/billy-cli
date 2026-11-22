import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common'
import { AppLogger } from '@repo/kits'
import { ToolEffectLedger } from './tool-effect.ledger.js'

/**
 * 超期派发的兜底扫描（`docs/design/tool-effect-ledger.md` §4）。
 *
 * 为什么需要独立的扫描器：`begin()` 里的「过期即 unknown」是**懒转换** —— 只有同一调用
 * 被重放时才会发生。崩溃之后再也没人重放的那条记录会永久停在 `dispatched`，
 * 事后对账时无法区分「真的还在跑」和「早就没人管了」。
 *
 * 只做一件事：把 `deadline_at` 已过的 `dispatched` 批量判成 `unknown`。它**不重试、不重跑**，
 * 也不改已有结论（条件写只覆盖 `dispatched`）。
 */
@Injectable()
export class ToolEffectSweeper implements OnApplicationBootstrap, OnApplicationShutdown {
  /** 扫描间隔：超期判定的精度是「分钟级」，不需要更密 */
  private static readonly INTERVAL_MS = 60_000
  private timer?: NodeJS.Timeout

  constructor(
    @Inject(ToolEffectLedger) private readonly ledger: ToolEffectLedger,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => {
      void this.sweep().catch((error: unknown) => {
        this.logger.error('tool_gateway.effect_sweep_failed', {
          reason: error instanceof Error ? error.message : String(error),
        })
      })
    }, ToolEffectSweeper.INTERVAL_MS)
    // 不阻塞进程退出
    this.timer.unref?.()
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer)
  }

  /** 跑一轮（测试直接调它，不依赖定时器） */
  async sweep(): Promise<number> {
    const count = await this.ledger.sweepExpired()
    if (count > 0) {
      this.logger.warn('tool_gateway.effect_expired', { count })
    }
    return count
  }
}
