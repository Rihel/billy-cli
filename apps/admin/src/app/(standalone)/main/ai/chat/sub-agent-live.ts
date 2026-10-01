import type { UIMessage } from 'ai'
import type { AgentRunModel } from '@repo/shared'

/**
 * 子助手的**实时过程**收集（纯函数，node 环境可单测）。
 *
 * 为什么单独成文件：这份数据有**两个消费方** —— 主时间线的紧凑卡（只看结论与状态）与
 * 右栏的实时明细（看推理 / 正文 / 工具往返）。消费方各扫一遍 parts 必然漂移，所以在一处收口。
 *
 * 数据来自服务端写进**父那一条流**的两类块（`agent-runner.ts` 的 `writeState` / `writeDelta`）：
 * - `data-sub-agent`：**带 `id = subRunId`** 的状态块 → AI SDK 按 `id` 归并成"当前快照"；
 * - `data-sub-agent-delta`：**不带 id** 的增量块 → 一块一个 part，逐帧累积。
 *
 * 一条必须如实交代的边界（服务端语义，前端改不了）：状态块按 id 归并意味着
 * **后者覆盖前者** —— 子助手跑起来之后，`status: 'running'` 那块会被工具事件块覆盖掉，
 * 所以"运行中"的 part 里只剩**最近一次**工具往返，工具往返的完整序列要等 run 结束
 * 从库里的子 run 时间线按需拉（见右栏的 `SubRunView`）。推理 / 正文增量不受影响（它们不带 id）。
 */

/** 增量（`data-sub-agent-delta` 块：不带 id，按到达顺序累计） */
export interface SubAgentDelta {
  kind: 'text' | 'reasoning'
  text: string
}

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

/** 一个子助手在实时流里能看到的全部内容（状态 + 增量 + 工具往返） */
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
  deltas: SubAgentDelta[]
  events: SubAgentEvent[]
}

/** 收集需要的 part 最小结构（`UIMessage['parts']` 与测试里的手写对象都能传） */
export interface SubAgentSourcePart {
  type: string
  id?: string
  data?: unknown
}

/** 子助手名字：run 的 `agentKey` 就是 `sub:<名字>`（服务端给子 run 的命名口径） */
export const subRunName = (agentKey: string): string =>
  agentKey.replace(/^sub:/, '') || '子助手'

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : null

const asText = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value : undefined

/**
 * 状态快照 → 已知字段的合并。**只覆盖"这次真的带了的字段"**：
 * 服务端每次 `writeState` 只带一部分（起跑带 `status` / `task`，过程带 `event`，收尾带全量），
 * 按字段合并才不会把已有的状态擦成"未知"。
 */
const mergeState = (live: SubAgentLive, data: Record<string, unknown>): void => {
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
    const kind = event.kind === 'tool-result' ? 'tool-result' : 'tool-call'
    live.events.push({
      kind,
      toolCallId: typeof event.toolCallId === 'string' ? event.toolCallId : null,
      toolKey: typeof event.toolKey === 'string' ? event.toolKey : null,
      input: event.input,
      output: event.output,
      errorText: typeof event.errorText === 'string' ? event.errorText : null,
      isError: event.isError === true,
    })
  }
}

/**
 * 从一条消息的 parts 里收集每个子助手的实时过程（**按首次出现的顺序**返回）。
 *
 * `runId` 的口径：状态块优先取 `data.runId`，退到 part 的 `id`（服务端两处都写的是同一个子 run id）；
 * 增量块只有 `data.runId`。两个都拿不到就跳过 —— 宁可少一张卡，也不把明细挂到错误的子助手上。
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
    const created: SubAgentLive = { runId, name: name ?? '子助手', deltas: [], events: [] }
    lives.set(runId, created)
    return created
  }

  for (const part of parts) {
    if (part.type === 'data-sub-agent') {
      const data = asRecord(part.data)
      if (!data) continue
      const runId = asText(data.runId) ?? part.id
      if (!runId) continue
      mergeState(ensure(runId, asText(data.name)), data)
      continue
    }
    if (part.type === 'data-sub-agent-delta') {
      const data = asRecord(part.data)
      if (!data) continue
      const runId = asText(data.runId)
      if (!runId) continue
      ensure(runId, asText(data.name)).deltas.push({
        kind: data.kind === 'reasoning' ? 'reasoning' : 'text',
        text: typeof data.text === 'string' ? data.text : '',
      })
    }
  }

  return [...lives.values()]
}

/**
 * 当前会话**最后一次**子助手活动所在消息里的实时数据。
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
 * `undefined` 也算在跑：运行中的状态块会被工具事件块覆盖（见文件头），
 * 那种情况下"没有最终状态"恰恰说明它还没收尾 —— 显示成"进行中"比显示"未知"诚实。
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
 * 为什么需要它：服务端为每次委派同时产生"一次工具调用"（`run-sub-agent` 的入参出参）与
 * "一个子 run 的状态块"，前端若各自画一张卡，用户看到的就是**同一件事出现两次**。
 * 子助手卡信息更全（名字 / 状态 / 步数与工具数 / token / 结论 / 指路右栏），所以留它、
 * 把原始工具卡吃掉 —— 与计划工具"同一件事只画一张卡"是同一条纪律。
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
 * 优先级：**最终结论**（`result`，跑完就有）> 运行中已产出的正文（`deltas` 里 `kind === 'text'` 的部分）。
 * 为什么不用推理增量：卡片是"看结论"的地方，推理属于过程，在右栏看更合适（那边有完整往返）。
 * 两样都没有 → 返回 `null`，由卡片给一句"还没产出正文"的诚实提示，而不是空白。
 */
export const subAgentBodyText = (live: SubAgentLive): string | null => {
  const result = live.result?.trim()
  if (result) return result
  const streamed = live.deltas
    .filter((delta) => delta.kind === 'text')
    .map((delta) => delta.text)
    .join('')
    .trim()
  return streamed || null
}
