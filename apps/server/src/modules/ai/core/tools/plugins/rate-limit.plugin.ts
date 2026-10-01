import { Inject, Injectable } from '@nestjs/common'
import { AppLogger } from '@repo/kits'
import { TOOL_RATE_COUNTER } from '../tool.ports.js'
import type { ToolRateCounter } from '../tool.ports.js'
import type { ToolCallContext, ToolOutcome, ToolPlugin } from '../tools.types.js'

/** 限流：每轮次数（按 run 计数）+ 时间窗（按工具 + 用户计数，多实例走 Redis） */
@Injectable()
export class RateLimitPlugin implements ToolPlugin {
  readonly name = 'rate-limit'

  constructor(
    @Inject(TOOL_RATE_COUNTER) private readonly counter: ToolRateCounter,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}

  async pre(ctx: ToolCallContext): Promise<ToolOutcome<never> | void> {
    const { maxPerTurn, rateLimit } = ctx.settings.limits
    if (maxPerTurn && ctx.caller) {
      // 轮内计数：TTL 给足一轮的时间（run 结束后由过期自然清掉）
      const used = await this.counter.incr(`ai:tool:turn:${ctx.caller.runId}:${ctx.toolKey}`, 3600)
      if (used > maxPerTurn) {
        this.logger.warn('ai.tool.rate_limited', {
          toolKey: ctx.toolKey,
          scope: 'turn',
          limit: maxPerTurn,
        })
        return {
          ok: false,
          reason: 'rate-limited',
          message: `这一轮里 ${ctx.toolKey} 已经调用了 ${maxPerTurn} 次（上限）`,
          hint: '用已经拿到的结果继续，或换一种更省调用的做法',
          retryable: false,
        }
      }
    }
    if (rateLimit) {
      const subject = ctx.caller?.userId ?? ctx.caller?.conversationId ?? 'anonymous'
      const used = await this.counter.incr(
        `ai:tool:rate:${ctx.toolKey}:${subject}`,
        rateLimit.windowSeconds,
      )
      if (used > rateLimit.max) {
        this.logger.warn('ai.tool.rate_limited', {
          toolKey: ctx.toolKey,
          scope: 'window',
          limit: rateLimit.max,
          windowSeconds: rateLimit.windowSeconds,
        })
        return {
          ok: false,
          reason: 'rate-limited',
          message: `${rateLimit.windowSeconds} 秒内 ${ctx.toolKey} 的调用次数已达上限（${rateLimit.max} 次）`,
          hint: '稍后再试；不要原地重试',
          retryable: true,
        }
      }
    }
  }
}
