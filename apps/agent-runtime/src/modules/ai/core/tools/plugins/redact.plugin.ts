import { Inject, Injectable } from '@nestjs/common'
import { AppLogger } from '@repo/kits'
import { serializeToolValue } from '../paginate.js'
import type { ToolCallContext, ToolPlugin } from '../tools.types.js'

/**
 * 秘钥脱敏：把出参里出现的秘钥明文换成提示串。
 *
 * 必须在**分页之前**跑：否则第一页里可能带着明文（日志 / 时间线 / 给模型的值都不该有明文）。
 */
@Injectable()
export class RedactPlugin implements ToolPlugin {
  readonly name = 'redact'

  constructor(@Inject(AppLogger) private readonly logger: AppLogger) {}

  post(ctx: ToolCallContext): void {
    const outcome = ctx.outcome
    if (!outcome?.ok) return
    const fields = ctx.spec.secretFields ?? []
    if (fields.length === 0) return
    const secrets = fields
      .map((field) => ({
        plain: ctx.settings.secret(field.name),
        hint: ctx.settings.secretHint(field.name) ?? '***',
      }))
      .filter((item): item is { plain: string; hint: string } => Boolean(item.plain))
    if (secrets.length === 0) return

    const serialized = serializeToolValue(outcome.data)
    let redacted = serialized
    for (const { plain, hint } of secrets) {
      if (plain && redacted.includes(plain)) redacted = redacted.split(plain).join(hint)
    }
    if (redacted === serialized) return
    try {
      ctx.outcome = { ...outcome, data: JSON.parse(redacted) }
      this.logger.debug('ai.tool.redacted', { toolKey: ctx.toolKey, fields: secrets.length })
    } catch {
      // 出参不是 JSON（工具返回了字符串）：直接给替换后的文本
      ctx.outcome = { ...outcome, data: redacted }
    }
  }
}
