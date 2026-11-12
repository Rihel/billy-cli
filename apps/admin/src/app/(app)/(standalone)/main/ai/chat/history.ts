import {
  ChatAttachmentSchema,
  TimelineKind,
  TimelineRole,
  type AgentRunModel,
  type AgentTimelineItemModel,
  type ChatAttachmentModel,
} from '@repo/shared'
import type { UIMessage } from 'ai'
import { z } from 'zod'
import { questionsOf, type Question, type QuestionAnswer, type SuspendedPartData } from './question-card'

/**
 * 时间线（数据库里的真相）→ UI 消息（AI SDK 的 `UIMessage`）。
 *
 * 为什么要这份映射：`useChat` 只认 `UIMessage`，而**历史不在浏览器里** ——
 * 刷新 / 换设备 / 换会话后，内容只能从 `timelines` 重建（设计文档 §3.13 第 ③ 条）。
 * 映射规则刻意保持"无损但不高保真"：
 *
 * 1. **只有根 run 的事件变成消息**（子 agent 的明细不铺进主对话，见第 3 条）；
 * 2. 一行时间线事件 → 一个 part：`text` / `reasoning` / 工具调用与结果（按 `tool_call_id` 配对）
 *    / `plan`（合成 `data-plan`，与会话页里的计划面板对齐）；
 * 3. `run-sub-agent` 的结论额外合成一条 `data-sub-agent` part —— 于是**历史里的子助手卡片
 *    与实时流看到的是同一种结构**（面板组件只认这一种 part）；
 * 4. **顺序与实时流一致**：工具卡按"调用发生的位置"就地铺开（结果到达时补出参），
 *    不能攒到最后统一追加 —— 那会让刷新后的历史与当时的界面长得不一样；
 * 5. **消息 id 与服务端流同源**（用时间线里的 `messageId`）：刷新后重连补发时，
 *    SDK 靠 id 认出"这就是同一条回答"才会**替换**而不是再 push 一条；
 * 4. 子 agent 的**完整过程**（推理 / 工具往返）不进主对话：它在子 run 的时间线里，
 *    由面板按需拉取（同一套只读接口，见 §3.14.3）。
 */

const textOf = (item: AgentTimelineItemModel): string => {
  const text = item.payload?.text
  return typeof text === 'string' ? text : ''
}

/**
 * 从用户消息事件里取出**附件元数据**（`payload.attachments`，见 `AgentUserMessagePayloadSchema`）。
 *
 * 只有 key 与元数据、没有文件内容 —— 回看时展示文件名与大小，要看原图/下载由页面另外签地址。
 * 形状不认识就返回空数组（老数据没有这个字段，是正常情况，不该报错）。
 */
const attachmentsOf = (item: AgentTimelineItemModel): ChatAttachmentModel[] => {
  const raw = item.payload?.attachments
  if (!Array.isArray(raw)) return []
  const parsed = z.array(ChatAttachmentSchema).safeParse(raw)
  return parsed.success ? parsed.data : []
}

/** 附件 → UI 的 file part（`url` 留空：回看时没有可直接渲染的地址，展示靠文件名与元数据） */
const toFileParts = (attachments: readonly ChatAttachmentModel[]): UIMessage['parts'] =>
  attachments.map((attachment) => ({
    type: 'file' as const,
    mediaType: attachment.mediaType,
    filename: attachment.filename,
    url: '',
    // 自带的字段（AI SDK 的类型不认识，但 JSON 会原样带到渲染层）
    attachmentKey: attachment.key,
    attachmentBytes: attachment.bytes,
  })) as unknown as UIMessage['parts']


const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : null

/**
 * 问答的答案：挂起行只记"问了什么"，答案在续跑成功补的那条 `tool-result` 里。
 *
 * 先把答案按 `toolCallId` 配好，挂起行才能**一次画出完整的问答**，
 * 而且卡片仍留在它自己的位置 —— 不能被挪到结果行去（那会打乱时间线顺序）。
 */
const answersByCallOf = (
  events: readonly AgentTimelineItemModel[],
): Map<string, unknown> => {
  const map = new Map<string, unknown>()
  for (const item of events) {
    if (item.kind !== TimelineKind.ToolResult || item.toolKey !== 'ask-user-questions') continue
    if (!item.toolCallId) continue
    map.set(item.toolCallId, item.payload?.output)
  }
  return map
}

/**
 * 老数据的兜底：2026-10-25 之前的续跑出参是 `formatAnswers()` 拼的整段文本
 * （`用户已回答：\n1. 题\n   答`），没有结构化 `answers`。
 *
 * 按题号切回来，让历史里的问答记录仍能逐题翻看；切不出来就放弃 ——
 * 宁可退化成"已回答但看不到原答"，也不猜用户答了什么。
 */
const parseLegacyAnswers = (
  output: unknown,
  questions: readonly Question[],
): QuestionAnswer[] | null => {
  const head = '用户已回答：'
  if (typeof output !== 'string' || !output.startsWith(head)) return null
  const groups: string[][] = []
  for (const rawLine of output.slice(head.length).split('\n')) {
    if (/^\d+\.\s/.test(rawLine)) {
      groups.push([])
      continue
    }
    if (groups.length > 0 && rawLine.trim()) groups[groups.length - 1]!.push(rawLine.trim())
  }
  if (groups.length !== questions.length) return null
  return questions.map((question, index) => ({
    id: question.id,
    value: groups[index]!.join('\n'),
  }))
}

/**
 * 把某个会话的时间线重建为消息列表。
 *
 * @param items 该会话的时间线（**含子 agent 的事件**，函数内部按 `runs` 过滤）
 * @param runs  该会话的运行列表（用来区分根 run 与子 run）
 * @param options.onlyRunIds 只重建这些 run（默认重建全部**根 run**）。
 *   右栏「子 agent 运行」用它把**某一个子 run** 单独渲染成一段对话 ——
 *   与主对话完全同一套映射、同一个渲染组件，所以子助手的过程"看起来和主 agent 一样"。
 */
export const toUIMessages = (
  items: AgentTimelineItemModel[],
  runs: AgentRunModel[],
  options: { onlyRunIds?: readonly string[] } = {},
): UIMessage[] => {
  const rootRunIds = new Set(
    options.onlyRunIds ?? runs.filter((run) => run.parentRunId === null).map((run) => run.id),
  )

  // 按 run 分组（保持时间线顺序），只有根 run 进入主对话
  const byRun = new Map<string, AgentTimelineItemModel[]>()
  for (const item of items) {
    if (!item.runId || !rootRunIds.has(item.runId)) continue
    const list = byRun.get(item.runId)
    if (list) list.push(item)
    else byRun.set(item.runId, [item])
  }

  const messages: UIMessage[] = []
  const runById = new Map(runs.map((run) => [run.id, run]))
  for (const [runId, events] of [...byRun.entries()].sort(
    (a, b) => (a[1][0]?.seq ?? 0) - (b[1][0]?.seq ?? 0),
  )) {
    const sorted = [...events].sort((a, b) => a.seq - b.seq)

    /**
     * 消息 id **优先用时间线里的 `messageId`**（= 服务端流的 `start` 块里那个 id）。
     *
     * 为什么这件事很关键：刷新时 `useChat({ resume: true })` 会从 offset 0 重放整轮，
     * SDK 拿重放流里的 messageId 去比对"最后一条消息" —— 对得上就**替换**，对不上就**再 push 一条**。
     * 历史里的 id 若是自己拼的（`<runId>-assistant`），永远对不上 → 同一个回答在界面上出现两份，
     * 而且历史一覆盖、流接着推，内容还会"缩水重来"（用户看到的"刷新后像没重连"）。
     */
    const userMessageId =
      sorted.find((item) => item.role === TimelineRole.User && item.messageId)?.messageId ?? undefined
    const assistantMessageId =
      sorted.find((item) => item.role === TimelineRole.Assistant && item.messageId)?.messageId ??
      undefined

    const userItems = sorted.filter(
      (item) => item.kind === TimelineKind.Text && item.role === TimelineRole.User,
    )
    const userText = userItems
      .map(textOf)
      .filter(Boolean)
      .join('\n')
    const attachments = userItems.flatMap(attachmentsOf)
    /**
     * 用户消息的重建条件：**有文字或有附件**。
     *
     * 早先的判据是"有文字"，于是"只发了一张图、没打字"的那条消息在刷新后**整条消失**
     * （附件是它的全部内容）。附件元数据从同一批用户事件里取。
     */
    if (userText || attachments.length > 0) {
      messages.push({
        // 用户消息没有 messageId（服务端只在助手侧落），用稳定的 run 前缀 id
        id: userMessageId ?? `${runId}-user`,
        role: 'user',
        parts: [
          ...(userText ? [{ type: 'text' as const, text: userText }] : []),
          ...toFileParts(attachments),
        ],
      })
    }

    const parts = toParts(sorted)
    // 用量：实时是收尾下发的 `data-run-usage`，历史（刷新 / 切会话）只能从 runs 重建 ——
    // 缺了它，回看历史时就只剩正文、统计全空（用户看到的"统计只在当场那一轮有"）。
    // 追加在最后，与实时流的位置一致。
    const run = runById.get(runId)
    if (run?.usage) {
      parts.push({
        type: 'data-run-usage',
        data: {
          runId,
          usage: run.usage,
          stepCount: run.stepCount,
          toolCallCount: run.toolCallCount,
          durationMs: run.durationMs ?? null,
        },
      } as UIMessage['parts'][number])
    }

    /**
     * **一个 part 都铺不出来时不要这条消息**：刷新可能发生在"这一轮刚开跑、库里只有 step 行"的时候，
     * 那种时候历史解析出来是个空壳 —— 界面上就是一个「（空消息）」气泡，看着像坏了；
     * 这轮真正的内容由重连补发（或下次刷新）补上，不需要历史先占一个空位。
     */
    if (parts.length === 0) continue
    messages.push({ id: assistantMessageId ?? `${runId}-assistant`, role: 'assistant', parts })
  }
  return messages
}

/** 工具卡的最小结构（AI SDK 的 `dynamic-tool` part；这里只用到这几个字段） */
interface ToolPartLike {
  type: 'dynamic-tool'
  toolName: string
  toolCallId: string
  state: 'input-available' | 'output-available' | 'output-error'
  input?: unknown
  output?: unknown
  errorText?: string
  /**
   * 这次调用的耗时（毫秒）—— 取服务端审计里的 `payload.outcome.durationMs`。
   *
   * 为什么从库里取而不是前端现算：刷新后前端只能从"挂载"开始算，算出来的是错的值；
   * 审计里那份是网关时钟量的真实耗时（`AuditEndPlugin`）。
   */
  durationMs?: number
}

/**
 * 从时间线行里取**真实耗时**（毫秒）。
 *
 * 两份来源，按可靠性排：
 * 1. 审计里的 `payload.outcome.durationMs`（网关时钟量的，工具卡用它）；
 * 2. 行自己的 `durationMs` 列（思考 / 文本行落库时记的，如果有）。
 *
 * 取不到就返回 `undefined` —— 调用方**不显示**，而不是拿"挂载到现在"冒充（那是错的值）。
 */
const durationMsOf = (item: AgentTimelineItemModel | undefined): number | undefined => {
  const audited = asRecord(item?.payload?.outcome)?.durationMs
  if (typeof audited === 'number' && Number.isFinite(audited)) return audited
  const own = item?.durationMs
  return typeof own === 'number' && Number.isFinite(own) ? own : undefined
}

/** 工具调用（或只有结果的历史残留）→ 一张卡；结果还没到时 `state` 是 `input-available` */
const toToolPart = (
  call: AgentTimelineItemModel | undefined,
  result: AgentTimelineItemModel | undefined,
): ToolPartLike => {
  const isError = result?.payload?.isError === true
  const output = result?.payload?.output
  return {
    type: 'dynamic-tool',
    toolName: (call?.toolKey ?? result?.toolKey ?? 'tool') as string,
    toolCallId: (call?.toolCallId ??
      result?.toolCallId ??
      `tool-${call?.seq ?? result?.seq ?? 0}`) as string,
    state: result ? (isError ? 'output-error' : 'output-available') : 'input-available',
    input: call?.payload?.input,
    ...(result ? (isError ? { errorText: JSON.stringify(output ?? '') } : { output }) : {}),
    ...(durationMsOf(result) !== undefined ? { durationMs: durationMsOf(result) } : {}),
  }
}

/** 结果到达：**就地补在这张卡上**（不新建 part —— 卡片的位置必须留在"调用发生的地方"） */
const applyToolResult = (part: ToolPartLike, result: AgentTimelineItemModel): void => {
  const isError = result.payload?.isError === true
  const output = result.payload?.output
  part.state = isError ? 'output-error' : 'output-available'
  if (isError) part.errorText = JSON.stringify(output ?? '')
  else part.output = output
  // 耗时在这里也要挂一次：绝大多数工具卡是"调用行 + 结果行"**配对**出来的（走这条路径），
  // 只在 `toToolPart` 挂会漏掉它们
  const durationMs = durationMsOf(result)
  if (durationMs !== undefined) part.durationMs = durationMs
}

/** 子助手的工具结论 → `data-sub-agent` part（与实时流同构）；不是子助手返回 null */
const toSubAgentPart = (
  result: AgentTimelineItemModel,
  toolName: string,
): UIMessage['parts'][number] | null => {
  if (toolName !== 'run-sub-agent') return null
  const outcome = asRecord(result.payload?.output)
  const subRunId = outcome?.subRunId
  if (typeof subRunId !== 'string') return null
  return {
    type: 'data-sub-agent',
    id: subRunId,
    data: { ...outcome, runId: subRunId },
  } as UIMessage['parts'][number]
}

/**
 * 一个 run 的事件 → assistant 消息的 parts。
 *
 * **工具卡按"调用发生的位置"就地铺开**（踩过的坑）：早先工具是攒到最后统一追加的，
 * 于是刷新后历史里的工具卡全被挪到消息末尾（正文在前、工具卡挤在下面），
 * 与实时流（AI SDK 边调边铺）的形态对不上 —— 用户看到的"刷新后工具调用排到后面去了"就是它。
 * 配对靠"先铺卡、结果到达时就地补出参"（对象按引用改，位置不变）。
 */
export const toParts = (events: AgentTimelineItemModel[]): UIMessage['parts'] => {
  const parts: UIMessage['parts'] = []
  /** 问答的答案（按 toolCallId 索引）：挂起行没有答案，配在续跑后的结果行里 */
  const answersByCall = answersByCallOf(events)
  /** `toolCallId` → 已经铺开的那张卡（结果到达时就地补） */
  const pending = new Map<string, ToolPartLike>()
  // 计划事件单独攒着，最后统一追加（与实时流一致：当前计划渲染在消息末尾）
  const plans: AgentTimelineItemModel[] = []

  for (const item of events) {
    if (item.role === TimelineRole.User) continue
    switch (item.kind) {
      case TimelineKind.Text: {
        const text = textOf(item)
        if (text) parts.push({ type: 'text', text })
        break
      }
      case TimelineKind.Reasoning: {
        const text = textOf(item)
        if (text) {
          // 思考时长：时间线行有起止时间，算得出真实秒数（否则 reasoning 组件会显示"思考完成"）
          const reasoningMs = durationMsOf(item)
          parts.push({
            type: 'reasoning',
            text,
            state: 'done',
            ...(reasoningMs !== undefined ? { durationMs: reasoningMs } : {}),
          })
        }
        break
      }
      case TimelineKind.ToolCall: {
        // 问题工具不铺原始工具卡：调用 + 挂起由 `data-tool-call-suspended` 一张卡表达
        if (item.toolKey === 'ask-user-questions') break
        const part = toToolPart(item, undefined)
        parts.push(part as unknown as UIMessage['parts'][number])
        if (item.toolCallId) pending.set(item.toolCallId, part)
        break
      }
      case TimelineKind.ToolSuspended: {
        // 挂起行 → 问题卡。若同一 toolCallId 后面已经有 ToolResult，说明已经续跑过：
        // 卡片不再让用户重复回答，而是**留在原位置**当只读的问答记录（`resumed: true`）。
        const toolCallId = item.toolCallId ?? undefined
        const output = toolCallId ? answersByCall.get(toolCallId) : undefined
        const answered = toolCallId ? answersByCall.has(toolCallId) : false
        const record = asRecord(output)
        const cancelled = record?.cancelled === true
        const structured = record?.answers
        const answers = Array.isArray(structured)
          ? (structured as QuestionAnswer[])
          : parseLegacyAnswers(
              output,
              questionsOf({
                suspendPayload: item.payload?.suspendPayload,
              } as SuspendedPartData),
            ) ?? undefined
        parts.push({
          type: 'data-tool-call-suspended',
          id: toolCallId ?? `suspended-${item.seq}`,
          data: {
            runId: item.payload?.runId ?? undefined,
            toolCallId,
            toolName: item.toolKey ?? 'ask-user-questions',
            suspendPayload: item.payload?.suspendPayload,
            resumed: answered,
            ...(cancelled ? { cancelled: true } : {}),
            ...(answers ? { answers } : {}),
          },
        } as unknown as UIMessage['parts'][number])
        break
      }
      case TimelineKind.ToolResult: {
        // `ask-user-questions` 的结果不进正文：问题卡已经表达了这次交互
        if (item.toolKey === 'ask-user-questions') break
        const part = item.toolCallId ? pending.get(item.toolCallId) : undefined
        if (part) {
          applyToolResult(part, item)
          const subAgent = toSubAgentPart(item, part.toolName)
          if (subAgent) parts.push(subAgent)
          break
        }
        // 只有结果没有调用（历史残留 / 协议漂移）：也**就地**补一张卡，别挪到末尾
        const orphan = toToolPart(undefined, item)
        parts.push(orphan as unknown as UIMessage['parts'][number])
        const subAgent = toSubAgentPart(item, orphan.toolName)
        if (subAgent) parts.push(subAgent)
        break
      }
      case TimelineKind.Plan: {
        // 计划事件 → `data-plan` part：**payload 原样带上**（计划卡片自己容错解析），
        // 于是历史里的计划与实时流"取最后一次 plan 出参"看到的是同一种结构
        plans.push(item)
        break
      }
      default:
        // 步骤 / 状态 / 摘要 / 错误：审计用，不进对话正文（在审计页看）
        break
    }
  }

  // 计划 part 追加在最后：会话页把"当前计划"渲染在消息末尾，历史与实时因此落在同一个位置。
  // `id` 用 `plan-<seq>` —— 一个 run 里可能有多条计划事件（每次 plan 工具调用一条），id 必须唯一。
  for (const item of plans) {
    parts.push({
      type: 'data-plan',
      id: `plan-${item.seq}`,
      data: item.payload ?? {},
    } as UIMessage['parts'][number])
  }
  return parts
}
