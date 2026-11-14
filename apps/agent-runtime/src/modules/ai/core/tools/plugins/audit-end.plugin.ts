import { Inject, Injectable } from '@nestjs/common'
import { AppLogger } from '@repo/kits'
import { serializeToolValue } from '../paginate.js'
import { ToolCallMetaStore } from '../tool.meta.js'
import type { ToolCallContext, ToolPlugin } from '../tools.types.js'

/**
 * 审计：写一份旁证（录制器写 `tool-result` 行时合并进 `payload.outcome`）+ 一条结构化日志。
 *
 * 必须在**最后**跑：它记的是最终结论（含是否分页、耗时、配置版本）。
 */
@Injectable()
export class AuditEndPlugin implements ToolPlugin {
  readonly name = 'audit-end'

  constructor(
    @Inject(ToolCallMetaStore) private readonly metas: ToolCallMetaStore,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}

  post(ctx: ToolCallContext): void {
    const outcome = ctx.outcome
    const durationMs = Math.max(0, ctx.clock.now() - (ctx.startedAt ?? ctx.clock.now()))
    const outputBytes =
      outcome?.ok === true ? Buffer.byteLength(serializeToolValue(outcome.data), 'utf8') : 0
    const caller = ctx.caller
    if (caller) {
      this.metas.put(caller.runId, ctx.toolCallId, {
        ok: outcome?.ok === true,
        ...(outcome?.ok === false ? { reason: outcome.reason } : {}),
        // "这次为什么调它"（模型必填的 reason）—— 拒绝路径上也要留下，才能解释"模型当时想干什么"
        ...(ctx.reason ? { callReason: ctx.reason } : {}),
        configVersion: ctx.configVersion ?? ctx.settings.version,
        durationMs,
        ...(ctx.page ? { page: ctx.page } : {}),
        outputBytes,
      })
    }
    const denied = outcome?.ok === false
    this.logger[denied ? 'warn' : 'info'](denied ? 'ai.tool.denied' : 'ai.tool.invoked', {
      toolKey: ctx.toolKey,
      conversationId: caller?.conversationId ?? null,
      runId: caller?.runId ?? null,
      userId: caller?.userId ?? null,
      depth: caller?.depth ?? null,
      toolCallId: ctx.toolCallId,
      durationMs,
      outputBytes,
      pages: ctx.page?.totalPages ?? null,
      reason: denied ? outcome.reason : null,
      // 模型写的调用理由（与上面的拒绝 reason 是两个东西，字段名分开）
      callReason: ctx.reason,
      configVersion: ctx.configVersion ?? ctx.settings.version,
    })
  }
}
