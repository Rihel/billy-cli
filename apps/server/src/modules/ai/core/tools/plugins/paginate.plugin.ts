import { Inject, Injectable } from '@nestjs/common'
import { AppLogger } from '@repo/kits'
import { serializeToolValue, makePageHandle, paginate } from '../paginate.js'
import { TOOL_ENV_CAPS } from '../tool.config.ports.js'
import { ToolResultStore } from '../tool-result.store.js'
import { isPagedToolValue } from '../tools.types.js'
import type { ToolCallContext, ToolEnvCaps, ToolPlugin } from '../tools.types.js'

/**
 * 分页：出参超过上限时，**返回值仍是全量**，只有"给模型的那一份"被适配器换成第一页。
 *
 * 为什么这样：`timelines` 存的是工具返回值（全量入库是硬规则），模型看到的是
 * `toModelOutput` 映射后的视图（用例 ① 实测）。本插件只负责把全量放进回取存储 + 记页头。
 */
@Injectable()
export class PaginatePlugin implements ToolPlugin {
  readonly name = 'paginate'

  constructor(
    @Inject(ToolResultStore) private readonly store: ToolResultStore,
    @Inject(TOOL_ENV_CAPS) private readonly caps: ToolEnvCaps,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}

  post(ctx: ToolCallContext): void {
    const outcome = ctx.outcome
    if (!outcome?.ok || !ctx.spec.paginate) return
    if (isPagedToolValue(outcome.data)) return
    const caller = ctx.caller
    if (!caller || !ctx.toolCallId) return // 没有会话或调用 id 就无法回取：不分页（宁可全量）

    const limit = Math.min(
      ctx.settings.limits.pageBytes ?? ctx.spec.paginate.pageBytes,
      this.caps.pageBytesMax,
    )
    const serialized = serializeToolValue(outcome.data)
    const bytes = Buffer.byteLength(serialized, 'utf8')
    if (bytes <= limit) return

    const handle = makePageHandle(caller.conversationId, ctx.toolCallId)
    this.store.remember(caller.conversationId, ctx.toolCallId, serialized)
    const page = paginate(serialized, limit, 1, handle)
    ctx.page = page.meta
    ctx.outcome = {
      ...outcome,
      data: { __toolPaged: true as const, page: page.meta, data: outcome.data },
    }
    this.logger.log('ai.tool.paged', {
      toolKey: ctx.toolKey,
      totalBytes: page.meta.totalBytes,
      totalPages: page.meta.totalPages,
      pageBytes: limit,
    })
  }
}
