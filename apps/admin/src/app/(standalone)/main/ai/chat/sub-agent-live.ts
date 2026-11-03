import type { UIMessage } from 'ai'
import type { AgentRunModel } from '@repo/shared'

/**
 * 子助手的过程数据：**一份聚合后的当前值**，不是逐帧增量数组。
 *
 * 为什么改（2026-11-03，会话 vske8ur0le74hwsfii0s 卡死）：原先这里存 `deltas[]`，每个流块 push
 * 一条，前端每帧再 `filter + map + join` 成正文。4 路并行子助手时一块一个增量 → 单条消息
 * 数万个 delta，页面每帧要在这堆数据上做多轮全量扫描。
 * 现在改为**写入时聚合**（字符串追加，O(1) 摊还），读的时候直接就是正文。
 *
 * 数据来源两处，合并规则同一份（`mergeSubAgentState` / `appendSubAgentDelta`）：
 * - 实时：`chat-session.ts` 在 `onData` 里收到 `data-sub-agent` / `data-sub-agent-delta` 块时写入；
 * - 历史：`collectSubAgentLives(parts)`（时间线重建出的 `data-sub-agent` part）。
 *
 * 一条必须如实交代的边界（服务端语义）：`data-sub-agent` 带 `id = subRunId`，按 id 归并意味着
 * **后者覆盖前者** —— 跑起来之后工具事件块会覆盖"running"那块，所以实时 part 里只剩最近一次
 * 工具往返；完整序列要等 run 结束从子 run 时间线拉（见右栏 `SubRunView`）。
 */

/** 子助手的工具往返（`data-sub-agent` 状态块里的 `event` 字段） */
export interface SubAgentEvent {
  kind: 'tool-call' | 'tool-result'
  toolCallId?: string | null
  toolKey?: string | null
  input?: unknown
  output?: unknown
  errorText?: string | null
  isError?: boolean
}

/** 一个子助手当前能看到的全部内容（状态 + 聚合正文 / 推理 + 工具往返） */
export interface SubAgentLive {
  runId: string
  /** 发起这次委派的 `run-sub-agent` 工具调用 id（主时间线据此去重：同一件事只画一张卡） */
  toolCallId?: string | null
  name: string
  status?: string
  task?: string
  result?: string
  error?: string | null
  reason?: string
  stepCount?: number
  toolCallCount?: number
  usage?: Record<string, unknown> | null
  durationMs?: number
  /** 已产出的正文（聚合后的当前值；运行中边跑边长） */
  text: string
  /** 已产出的推理（同上） */
  reasoning: string
  events: SubAgentEvent[]
}

/** 收集需要的 part 最小结构（`UIMessage['parts']` 与测试里的手写对象都能传） */
export interface SubAgentSourcePart {
  type: string
  id?: string
  data?: unknown
}

/** 子助手的空快照：实时与历史两条链路都从这里起手，字段不会缺 */
export const emptySubAgent = (runId: string, name = '子助手'): SubAgentLive => ({
  runId,
  name,
  text: '',
  reasoning: '',
  events: [],
})

/** 子助手名字：run 的 `agentKey` 就是 `sub:<名字>`（服务端给子 run 的命名口径） */
export const subRunName = (agentKey: string): string =>
  agentKey.replace(/^sub:/, '') || '子助手'

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : null

const asText = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value : undefined

/**
 * 状态快照 → 就地合并到目标对象。**只覆盖"这次真的带了的字段"**：
 * 服务端每次 `writeState` 只带一部分（起跑带 `status` / `task`，过程带 `event`，收尾带全量），
 * 按字段合并才不会把已有的状态擦成"未知"。
 *
 * 实时与会史共用这一份合并规则，否则卡片在两种数据源下会长得不一样。
 */
export const mergeSubAgentState = (live: SubAgentLive, data: Record<string, unknown>): void => {
  const name = asText(data.name)
  if (name) live.name = name
  const status = asText(data.status)
  if (status) live.status = status
  const task = asText(data.task)
  if (task) live.task = task
  const toolCallId = asText(data.toolCallId)
  if (toolCallId) live.toolCallId = toolCallId
  if (typeof data.result === 'string') live.result = data.result
  if (typeof data.error === 'string' || data.error === null) live.error = data.error
  const reason = asText(data.reason)
  if (reason) live.reason = reason
  if (typeof data.stepCount === 'number') live.stepCount = data.stepCount
  if (typeof data.toolCallCount === 'number') live.toolCallCount = data.toolCallCount
  if (typeof data.durationMs === 'number') live.durationMs = data.durationMs
  const usage = asRecord(data.usage)
  if (usage) live.usage = usage
  const event = asRecord(data.event)
  if (event) {
    live.events.push({
      kind: event.kind === 'tool-result' ? 'tool-result' : 'tool-call',
      toolCallId: typeof event.toolCallId === 'string' ? event.toolCallId : null,
      toolKey: typeof event.toolKey === 'string' ? event.toolKey : null,
      input: event.input,
      output: event.output,
      errorText: typeof event.errorText === 'string' ? event.errorText : null,
      isError: event.isError === true,
    })
  }
}

/** 增量块 → 追加到聚合字段（字符串追加，不做逐帧数组） */
export const appendSubAgentDelta = (
  live: SubAgentLive,
  kind: 'text' | 'reasoning',
  text: string,
): void => {
  if (!text) return
  if (kind === 'reasoning') live.reasoning += text
  else live.text += text
}

/**
 * 从一条消息的 parts 里收集每个子助手（**按首次出现的顺序**返回）。
 *
 * `runId` 的口径：状态块优先取 `data.runId`，退到 part 的 `id`（服务端两处写的是同一个子 run id）；
 * 增量块只有 `data.runId`。两个都拿不到就跳过 —— 宁可少一张卡，也不把明细挂到错误的子助手上。
 *
 * 历史链路专用于此：时间线重建出来的只有 `data-sub-agent`（无增量），正文由 `result` 承担。
 */
export const collectSubAgentLives = (
  parts: readonly SubAgentSourcePart[],
): SubAgentLive[] => {
  const lives = new Map<string, SubAgentLive>()

  const ensure = (runId: string, name?: string): SubAgentLive => {
    const existing = lives.get(runId)
    if (existing) {
      if (name) existing.name = name
      return existing
    }
    const created = emptySubAgent(runId, name)
    lives.set(runId, created)
    return created
  }

  for (const part of parts) {
    if (part.type === 'data-sub-agent') {
      const data = asRecord(part.data)
      if (!data) continue
      const runId = asText(data.runId) ?? part.id
      if (!runId) continue
      mergeSubAgentState(ensure(runId, asText(data.name)), data)
      continue
    }
    // 旧协议残留（增量曾以持久 part 落进消息）：仍按顺序聚合，保证既有历史不丢正文。
    if (part.type === 'data-sub-agent-delta') {
      const data = asRecord(part.data)
      if (!data) continue
      const runId = asText(data.runId)
      if (!runId) continue
      appendSubAgentDelta(
        ensure(runId, asText(data.name)),
        data.kind === 'reasoning' ? 'reasoning' : 'text',
        typeof data.text === 'string' ? data.text : '',
      )
    }
  }

  return [...lives.values()]
}

/**
 * 最后一条含子助手块的消息里的子助手数据。
 *
 * 为什么从后往前找"有子助手 part 的那条"而不是死认最后一条消息：
 * 流刚收尾时最后一条可能已经翻页到别的消息（或还没拿到 `data-sub-agent`），
 * 而子助手的过程仍在上一条里 —— 找"最后一条含子助手块的消息"两种情况都覆盖得到。
 */
export const liveSubAgentsOf = (messages: readonly UIMessage[]): SubAgentLive[] => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const parts = messages[index]?.parts ?? []
    if (parts.some((part) => part.type.startsWith('data-sub-agent'))) {
      return collectSubAgentLives(parts)
    }
  }
  return []
}

/**
 * 子助手是否**还在跑**。
 *
 * `undefined` 也算在跑：运行中的状态块会被工具事件块覆盖，那种情况下"没有最终状态"
 * 恰恰说明它还没收尾 —— 显示成"进行中"比显示"未知"诚实。
 */
export const isSubAgentActive = (live: SubAgentLive): boolean =>
  live.status === undefined || live.status === 'running'

/** 展示用状态：拿不到最终状态时按"进行中"算（口径同一处，卡片与右栏不分叉） */
export const subAgentStatus = (live: SubAgentLive): string => live.status ?? 'running'

/** 右栏的一个 tab（库里的 run 与实时数据合流后的结果） */
export interface SubAgentTab {
  runId: string
  name: string
  /** 库里的子 run（刷新后 / 跑完之后按需拉它的完整时间线） */
  run?: AgentRunModel
  /** 实时流里收集到的过程（运行中就有内容可看） */
  live?: SubAgentLive
  /** 是否运行中（实时在跑，或库里的 run 还是 `running`） */
  active: boolean
}

/**
 * 库里的子 run 与实时数据 → 右栏的 tab 列表。
 *
 * 为什么要合流：`runs` 是一次查询（刚起步的子 run 可能还没进这份数据），而实时块**立刻**就有；
 * 只认其中一边就会出现"明明在跑，右栏却是空的"或"跑完了 tab 反而少了"。
 * 顺序以库里的 run 为准（稳定），实时独有的追加在后面（新起的那个自然排到最后）。
 */
export const subAgentTabs = (
  runs: readonly AgentRunModel[],
  lives: readonly SubAgentLive[],
): SubAgentTab[] => {
  const liveById = new Map(lives.map((live) => [live.runId, live]))
  const tabs: SubAgentTab[] = []
  const seen = new Set<string>()

  for (const run of runs) {
    const live = liveById.get(run.id)
    tabs.push({
      runId: run.id,
      name: subRunName(run.agentKey),
      run,
      ...(live ? { live } : {}),
      active: run.status === 'running' || (live ? isSubAgentActive(live) : false),
    })
    seen.add(run.id)
  }
  for (const live of lives) {
    if (seen.has(live.runId)) continue
    tabs.push({
      runId: live.runId,
      name: live.name,
      live,
      active: isSubAgentActive(live),
    })
  }
  return tabs
}

/**
 * **被委派的工具调用 id**（`run-sub-agent` 的那些）—— 主时间线据此去重。
 *
 * 服务端为每次委派同时产生"一次工具调用"与"一个子 run 的状态块"，各自画卡就是同一件事出现两次。
 * 子助手卡信息更全，所以留它、把原始工具卡吃掉 —— 与计划工具"同一件事只画一张卡"同一条纪律。
 */
export const delegatedToolCallIds = (
  lives: readonly SubAgentLive[],
): ReadonlySet<string> =>
  new Set(
    lives
      .map((live) => live.toolCallId)
      .filter((toolCallId): toolCallId is string => Boolean(toolCallId)),
  )

/**
 * 子助手紧凑卡**展开后要显示的正文**（纯函数，可单测）。
 *
 * 优先级：**最终结论**（`result`，跑完就有）> 运行中已产出的正文（`text`）。
 * 两样都没有 → 返回 `null`，由卡片给一句"还没产出正文"的诚实提示，而不是空白。
 */
export const subAgentBodyText = (live: SubAgentLive): string | null => {
  const result = live.result?.trim()
  if (result) return result
  const streamed = live.text.trim()
  return streamed || null
}

/**
 * 两个来源的同一个子助手合成一个可渲染对象（实时优先，缺的字段用另一方补）。
 *
 * 运行中主对话里的卡片数据来自实时 store（结论可能还没出），历史里同一张卡来自
 * `data-sub-agent` part —— 刷新前后不能变成两种形状。
 */
export const mergeSubAgent = (base: SubAgentLive, patch?: SubAgentLive): SubAgentLive => {
  if (!patch) return base
  return {
    ...base,
    ...patch,
    name: patch.name || base.name,
    // 文本类字段取"更长的那个"：实时可能在补，历史可能是最终结论
    text: patch.text.length >= base.text.length ? patch.text : base.text,
    reasoning: patch.reasoning.length >= base.reasoning.length ? patch.reasoning : base.reasoning,
    events: patch.events.length > 0 ? patch.events : base.events,
  }
}
