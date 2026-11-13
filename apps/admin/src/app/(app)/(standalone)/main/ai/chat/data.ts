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

/**
 * 从消息列表里取**最近一轮的用量**（`data-run-usage` 里那层 `usage`）。
 *
 * ⚠️ **层级**（踩过，界面上一度 token 全是"—"）：服务端下发的块是
 * `{ type: 'data-run-usage', data: { runId, usage: { inputTokens, … }, stepCount, toolCallCount, durationMs } }`
 * —— token 字段在 **`data.usage` 里**，`stepCount` / `durationMs` 在外层。
 * 所以这里必须往下钻一层：早先直接返回 `data`，于是 `usage.inputTokens` 恒为 `undefined`，
 * 行内只剩"轮 / 步"是真的、token 全是"—"。
 *
 * 为什么从后往前找：用量块挂在**本轮最后一条 assistant 消息**上，"最近一轮"就是刚跑完的那一轮。
 * 拿不到（还没跑过 / 流还没收尾）→ `null`，调用方整行不显示 —— 不编造 0。
 *
 * 返回**拍平后**的对象（token 字段 + 外层 `stepCount` / `toolCallCount` / `durationMs`）：
 * 渲染层 `usage.inputTokens` 与 `usage.stepCount` 都能直接取，不必知道服务端的嵌套形状。
 */
export const lastRunUsage = (messages: UIMessage[]): Record<string, unknown> | null => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (!message || message.role !== 'assistant') continue
    // 断言成"数据 part"：`UIMessagePart` 联合里 data-* 是模板字面量类型，与具体字面量比较不收窄
    const part = [...message.parts].reverse().find((item) => item.type === 'data-run-usage') as
      | { data?: Record<string, unknown> }
      | undefined
    if (!part?.data) continue
    const data = part.data
    const tokens = data.usage
    const tokenRecord =
      tokens && typeof tokens === 'object' ? (tokens as Record<string, unknown>) : {}
    // 一个 token 字段都没有 → 视为"没有用量"：整行不渲染。
    // 否则会显示成 `3 轮 1 步，输入 —，输出 —`（用户截到的就是这个"半截行"，很难看出是缺数据）
    const hasTokens = ['inputTokens', 'outputTokens', 'totalTokens'].some(
      (field) => typeof tokenRecord[field] === 'number',
    )
    if (!hasTokens) return null
    return {
      ...tokenRecord,
      stepCount: data.stepCount,
      toolCallCount: data.toolCallCount,
      durationMs: data.durationMs,
    }
  }
  return null
}
