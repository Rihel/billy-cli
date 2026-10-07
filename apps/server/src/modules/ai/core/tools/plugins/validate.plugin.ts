import { Injectable } from '@nestjs/common'
import { TOOL_CALL_REASON_MIN, checkToolCall } from '../call-reason.js'
import type { ToolCallContext, ToolOutcome, ToolPlugin } from '../tools.types.js'

/**
 * 入参校验与归一化：补默认值、摘出必填的 `reason`、统一校验话术
 * （schema 那层上游已校验过，这里管语义与话术，并且是 `reason` 纪律的**唯一实现处**）。
 */
@Injectable()
export class ValidatePlugin implements ToolPlugin {
  readonly name = 'validate'

  pre(ctx: ToolCallContext): ToolOutcome<never> | void {
    const schema = (ctx.spec.modelParams ?? ctx.spec.params) as Parameters<typeof checkToolCall>[0]
    const checked = checkToolCall(schema, ctx.rawInput)
    if (!checked.ok) {
      return {
        ok: false,
        reason: 'invalid-input',
        message: checked.message,
        hint: `按工具的参数说明补上 reason（一句话说清这次为什么用它，至少 ${TOOL_CALL_REASON_MIN} 个字）再调，别原样重试`,
        retryable: false,
      }
    }
    // 先把 reason 摘到 ctx（工具可以读它），再让执行体拿到**不含 reason** 的原定义入参
    ctx.reason = checked.reason
    ctx.input = checked.input
  }
}
