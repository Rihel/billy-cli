import { Injectable } from '@nestjs/common'
import type { ToolCallContext, ToolOutcome, ToolPlugin } from '../tools.types.js'

/** 入参校验与归一化：补默认值、统一校验话术（schema 那层上游已校验过，这里管语义与话术） */
@Injectable()
export class ValidatePlugin implements ToolPlugin {
  readonly name = 'validate'

  pre(ctx: ToolCallContext): ToolOutcome<never> | void {
    const parsed = ctx.spec.params.safeParse(ctx.rawInput)
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '(根)'}: ${issue.message}`)
        .join('；')
      return {
        ok: false,
        reason: 'invalid-input',
        message: `入参不合法（${detail}）`,
        hint: '按工具的参数说明改一版再调，别原样重试',
        retryable: false,
      }
    }
    ctx.input = parsed.data
  }
}
