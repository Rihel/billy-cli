import { Injectable } from '@nestjs/common'
import type { ToolCallContext, ToolOutcome, ToolPlugin } from '../tools.types.js'

/** 前置条件：必填秘钥是否配齐 + 工具自己的**只读**检查（目录边界、目标是否存在…） */
@Injectable()
export class PrecheckPlugin implements ToolPlugin {
  readonly name = 'precheck'

  async pre(ctx: ToolCallContext): Promise<ToolOutcome<never> | void> {
    const missing = (ctx.spec.secretFields ?? [])
      .filter((field) => field.required)
      .filter((field) => ctx.settings.secret(field.name) === null)
      .map((field) => field.label)
    if (missing.length > 0) {
      return {
        ok: false,
        reason: 'precheck-failed',
        message: `这个工具还没配置好：缺少 ${missing.join('、')}`,
        hint: '请管理员在后台「工具配置」里补齐，或换用其它工具',
        retryable: false,
      }
    }
    const reason = await ctx.spec.precheck?.(ctx.input as never, ctx as never)
    if (!reason) return
    return {
      ok: false,
      reason: 'precheck-failed',
      message: reason,
      hint: '按上面这句话调整入参或做法',
      retryable: false,
    }
  }
}
