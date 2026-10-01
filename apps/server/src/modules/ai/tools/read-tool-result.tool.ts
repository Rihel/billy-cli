import { Inject, Injectable } from '@nestjs/common'
import dedent from 'dedent'
import { z } from 'zod'
import { ToolDecl, ToolGroup } from '../core/tools/tool.decorator.js'
import { paginate, parsePageHandle } from '../core/tools/paginate.js'
import { TOOL_RATE_COUNTER } from '../core/tools/tool.ports.js'
import type { ToolRateCounter } from '../core/tools/tool.ports.js'
import { ToolResultStore } from '../core/tools/tool-result.store.js'
import { TOOL_RESULT_KEYS } from '../core/tools/tool-keys.js'
import { TOOL_ENV_CAPS } from '../core/tools/tool.config.ports.js'
import { ToolDeniedError } from '../core/tools/tools.types.js'
import type { ToolCallContext, ToolEnvCaps } from '../core/tools/tools.types.js'

/**
 * `read-tool-result`：**取分页的下一页**（设计 §5.6 的回取通道）。
 *
 * 它是内建工具（与其余工具同一个类 DSL），走同一套网关与插件：
 * 于是取页也会受限流、作用域、审计约束，出参再大也不会自己套一层分页（它天然只有一页）。
 *
 * 两条防护：
 * - **越权**：句柄里的会话必须与当前会话一致（否则就是拿别人的句柄读别人的工具结果）；
 * - **滥用**：每轮取页次数有上限（`maxPagesPerTurn`），防止模型反复取页烧 token。
 */
const ReadToolResultInputSchema = z.object({
  handle: z.string().min(1).max(128).describe('上一页给出的取页句柄（`page.handle`，原样传回）'),
  page: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('要取的页码（从 1 开始）；省略即取第 1 页'),
})

const ReadToolResultConfigSchema = z.object({
  /** 单页字节数（工具级覆盖；另有每轮取页上限在 `limits` 里） */
  pageBytes: z.number().int().positive().default(8 * 1024),
})

const ReadToolResultOutputSchema = z.object({
  page: z.object({
    page: z.number(),
    pageSize: z.number(),
    totalBytes: z.number(),
    totalPages: z.number(),
    hasMore: z.boolean(),
    handle: z.string(),
  }),
  content: z.string(),
})

/** **取页工具组**：一个组一个类、组内一个方法一个工具（设计 §5.2），依赖走构造器注入 */
@Injectable()
@ToolGroup({ category: 'core', scope: 'all' })
export class ReadToolResultTool {
  constructor(
    @Inject(ToolResultStore) private readonly store: ToolResultStore,
    @Inject(TOOL_RATE_COUNTER) private readonly counter: ToolRateCounter,
    @Inject(TOOL_ENV_CAPS) private readonly caps: ToolEnvCaps,
  ) {}

  @ToolDecl({
    key: TOOL_RESULT_KEYS.readToolResult,
    title: '读取工具结果的下一页',
    params: ReadToolResultInputSchema,
    result: ReadToolResultOutputSchema,
    config: ReadToolResultConfigSchema,
    description: dedent`
      读取某个工具结果的**后续页**。

      什么时候用：工具结果里出现 \`page\` 与 \`handle\`（说明它太大，只给了你一页），
      而你需要后面的内容时 —— 传回那个 \`handle\` 与要取的 \`page\`。

      纪律：
      - 先看第一页够不够用；够用就别取（每次取页都要花 token）；
      - 取页拿不到"摘要"，拿到的是**原文片段**，自己判断该看哪一页；
      - 同一个 \`handle\` 可以反复取（结果已入库），但每轮取页次数有上限。
    `,
  })
  async execute(
    input: z.infer<typeof ReadToolResultInputSchema>,
    ctx: ToolCallContext<z.infer<typeof ReadToolResultConfigSchema>>,
  ): Promise<z.infer<typeof ReadToolResultOutputSchema>> {
    const caller = ctx.caller
    const parsed = parsePageHandle(input.handle)
    if (!parsed) {
      throw new ToolDeniedError('invalid-input', '取页句柄格式不对（应当原样传回结果里的 handle）')
    }
    if (!caller) {
      throw new ToolDeniedError('forbidden', '取页需要运行时身份（编排层未注入信封）')
    }
    // 越权防护：句柄必须属于当前会话
    if (parsed.conversationId !== caller.conversationId) {
      throw new ToolDeniedError('forbidden', '这个句柄不属于当前会话，不能读取')
    }

    // 滥用防护：每轮取页次数上限
    const maxPages = ctx.settings.limits.maxPagesPerTurn ?? this.caps.maxPagesPerTurnMax
    const used = await this.counter.incr(`ai:tool:pages:${caller.runId}`, 3600)
    if (used > maxPages) {
      throw new ToolDeniedError(
        'rate-limited',
        `这一轮取页次数已达上限（${maxPages} 次）`,
        '用已经取到的内容作答，或把工具入参收窄一点重跑那个工具',
      )
    }

    const full = await this.store.resolve(parsed.conversationId, parsed.toolCallId)
    if (full === null) {
      throw new ToolDeniedError(
        'precheck-failed',
        '这一页取不到了：原始结果不在内存里、时间线里也没有它的全文',
        '重跑一次产生这个结果的工具（入参收窄一点），或先用已经拿到的内容作答',
      )
    }

    const pageBytes = Math.min(
      ctx.settings.limits.pageBytes ?? ctx.settings.config.pageBytes,
      this.caps.pageBytesMax,
    )
    const page = paginate(full, pageBytes, input.page ?? 1, input.handle)
    return { page: page.meta, content: page.content }
  }
}
