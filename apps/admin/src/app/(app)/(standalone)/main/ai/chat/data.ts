import type { UIMessage } from 'ai'
import type { AgentRunModel, AgentTimelineItemModel } from '@repo/shared'
import type { useServerClient } from '@/lib/server-client'

/**
 * 会话页的数据加载口径（翻页取全 + 用量读取）。
 *
 * 为什么单独成文件：会话页要按会话拆成路由（`/main/ai/chat/[conversationId]`），
 * 页面、子助手面板都要用同一套加载口径 —— 各写一份必然漂移（上限写错就是 400）。
 */

/** 会话页用到的客户端（从 hook 的返回值取，避免为"一个类型"多引一层） */
export type ServerClient = ReturnType<typeof useServerClient>

/**
 * 时间线一次最多取多少条 —— **必须是后端 `BasePaginateSchema` 的上限（100）**。
 *
 * 踩过的坑：这里原先写 500，后端直接回 400「每页条数不能超过100」（校验在 schema 层），
 * `Promise.all` 于是整体抛错 —— 表现就是**点会话什么都不显示**。
 * 上限不属于前端可协商的东西：要更多只能用 page 翻页（见 `loadWholeTimeline`）。
 */
export const TIMELINE_PAGE_SIZE = 100
/** 一次「翻完整个会话时间线」的翻页上限（防病态会话把浏览器拖死） */
export const TIMELINE_MAX_PAGES = 20
/** 运行列表一页多少条（同上：不得越过 100） */
export const RUN_PAGE_SIZE = 100

/**
 * 把一个会话（或其中某一轮）的时间线**翻页取全**。
 *
 * 为什么不新增"一次性拉全量"的后端口子：历史重建必须完整，而分页是既有能力，
 * 前端翻页足以支撑当前规模（`TIMELINE_MAX_PAGES × 100` 条）。
 *
 * @param runId 只取某一轮（子助手明细用）；省略取整个会话
 */
export const loadWholeTimeline = async (
  client: ServerClient,
  conversationId: string,
  runId?: string,
): Promise<AgentTimelineItemModel[]> => {
  const items: AgentTimelineItemModel[] = []
  for (let page = 1; page <= TIMELINE_MAX_PAGES; page += 1) {
    const result = await client.agent.timeline.list({
      conversationId,
      ...(runId ? { runId } : {}),
      page,
      size: TIMELINE_PAGE_SIZE,
    })
    items.push(...result.items)
    // 两个终止条件都要：`items.length >= total` 是正常结束；空页是"后端 total 与实际不一致"时的兜底
    if (result.items.length === 0 || items.length >= result.total) break
  }
  return items
}

/** 把一个会话的运行列表**翻页取全**（`toUIMessages` 要用它区分根 run 与子 run，少一条就会丢消息） */
export const loadWholeRuns = async (
  client: ServerClient,
  conversationId: string,
): Promise<AgentRunModel[]> => {
  const items: AgentRunModel[] = []
  for (let page = 1; page <= TIMELINE_MAX_PAGES; page += 1) {
    const result = await client.agent.run.list({ conversationId, page, size: RUN_PAGE_SIZE })
    items.push(...result.items)
    if (result.items.length === 0 || items.length >= result.total) break
  }
  return items
}

/** 用量里参与"相加"的 token 字段（与 `usage.ts` 的 `mergeUsage` 同一张表） */
const TOKEN_FIELDS = [
  'inputTokens',
  'outputTokens',
  'totalTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'reasoningTokens',
] as const

/** 在**一条**消息里倒着找最新用量块；跳过没有 token 字段的块（不显示半截行），找不到返回 `null` */
const usageOfMessage = (message: UIMessage): Record<string, unknown> | null => {
  for (let index = message.parts.length - 1; index >= 0; index -= 1) {
    const part = message.parts[index] as
      | { type?: string; data?: Record<string, unknown> }
      | undefined
    if (part?.type !== 'data-run-usage' && part?.type !== 'data-step-usage') continue
    const data = part.data
    if (!data) continue
    const tokens = data.usage
    const tokenRecord =
      tokens && typeof tokens === 'object' ? (tokens as Record<string, unknown>) : {}
    // 一个 token 字段都没有 → 视为"没有用量"（provider 没上报，或这一步还没结束）。
    // 不显示成 `3 轮 1 步，输入 —，输出 —`（用户截到的就是这个"半截行"，很难看出是缺数据）
    const hasTokens = ['inputTokens', 'outputTokens', 'totalTokens'].some(
      (field) => typeof tokenRecord[field] === 'number',
    )
    if (!hasTokens) continue
    return {
      ...tokenRecord,
      stepCount: data.stepCount,
      toolCallCount: data.toolCallCount,
      durationMs: data.durationMs,
    }
  }
  return null
}

/**
 * 会话**累计**用量（右下角那一行显示的就是它）：把每条助手消息上最新的用量块相加。
 *
 * ## 为什么是"累计"而不是"本轮"
 *
 * 用户的口径（2026-11-14 明确）：`N 轮 M 步，输入 X…` 里的步与 token 是**整个会话的累计** ——
 * "6 轮 1 步"那种读法（轮是序号、步是本轮次数）会让人以为步数没在累加。
 * 累计值不再需要服务端额外接口：`history.ts` 已经把每一轮的 `data-run-usage` 挂回对应的
 * 助手消息（历史），实时这一轮挂的是 `data-step-usage`（每步一条）—— 消息列表本身就是账本。
 *
 * 三条口径：
 * - **一轮取一条**：同一条消息里有实时块与收尾块时，取最新那条（收尾块追加在最后）；
 * - **缺失不编 0**：某轮没上报 token 就不加进合计；整个会话一条都没有 → `null`（整行不渲染）；
 * - **轮数 = 助手消息数**（含正在跑的那条、含失败的那条）：与"第几轮"同一个数，读作
 *   "到第 6 轮、累计 20 步"。
 *
 * @param messages - 当前会话的消息列表（含正在流的那条）。
 * @returns `{ usage, turns }`；没有任何可用用量时返回 `null`。
 */
export const sessionUsageOf = (
  messages: UIMessage[],
): { usage: Record<string, unknown>; turns: number } | null => {
  let turns = 0
  let hasUsage = false
  const sums = new Map<string, number>()
  /** 只加"真的上报了"的数字：某一轮缺字段不影响其它轮（不补 0） */
  const add = (field: string, value: unknown): void => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return
    sums.set(field, (sums.get(field) ?? 0) + value)
  }

  for (const message of messages) {
    if (message.role !== 'assistant') continue
    turns += 1
    const usage = usageOfMessage(message)
    if (!usage) continue
    hasUsage = true
    for (const field of TOKEN_FIELDS) add(field, usage[field])
    add('stepCount', usage.stepCount)
    add('durationMs', usage.durationMs)
  }
  if (!hasUsage) return null

  const usage: Record<string, unknown> = {}
  for (const field of TOKEN_FIELDS) usage[field] = sums.get(field) ?? null
  usage.stepCount = sums.get('stepCount') ?? 0
  usage.durationMs = sums.get('durationMs') ?? null
  return { usage, turns }
}

/**
 * **本轮**用量（悬停详情里单独给一段）：最新一条助手消息上的用量块。
 *
 * 拿不到（这一轮第一步还没跑完 / 没上报）→ `null`，悬停里就不出现"本轮"那一行 ——
 * **不**回退到上一轮：那样会把上一轮的数当成这一轮。
 */
export const currentTurnUsage = (messages: UIMessage[]): Record<string, unknown> | null => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (!message || message.role !== 'assistant') continue
    return usageOfMessage(message)
  }
  return null
}
