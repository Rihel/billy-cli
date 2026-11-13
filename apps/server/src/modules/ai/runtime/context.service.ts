import { Inject, Injectable } from '@nestjs/common'
import { AppLogger } from '@repo/kits'
import { TimelineKind, TimelineRole, estimateContentTokens } from '@repo/shared'
import type { ModelMessage } from 'ai'
import { getContextWindow } from 'tokenlens'
import type { TimelineEntity } from '../../../database/entities/timeline-entity.js'
import { AgentConfig, type AgentConfig as AgentConfigValue } from '../core/config.js'
import { ContextTooLongError } from '../core/errors.js'
import { paginate, serializeToolValue, toModelPage } from '../core/tools/paginate.js'
import { isPagedToolValue } from '../core/tools/tools.types.js'
import { TimelineRepository } from './timeline.repository.js'

/** 一次组装最多读这么多事件（防止超长会话把内存撑爆；超出的本来就该被压缩） */
const MAX_EVENTS = 2000

/** 窗口解析结果（含来源，落进快照供审计） */
export interface ContextWindowResolution {
  windowTokens: number
  /**
   * 窗口的来源：
   * - `provider`：**后台模型配置里的实测值**（`ai_models.context_window`）——最可信，优先用它；
   * - `config`：配置里按模型覆盖的窗口（`AGENT_CONTEXT_MODEL_WINDOWS`）；
   * - `registry`：tokenlens 查到的公开窗口；
   * - `fallback`：都没查到，用保守兜底值（会打 warn）。
   */
  source: 'provider' | 'config' | 'registry' | 'fallback'
}

/** 落 `runs.request_snapshot.context` 的证据：给了什么、没给什么、拿什么顶替了 */
export interface ContextSnapshot {
  strategy: 'window' | 'trim' | 'trim+compact' | 'fallback'
  model: string
  windowTokens: number
  windowSource: ContextWindowResolution['source']
  triggerRatio: number
  budgetTokens: number
  estimatedInputTokens: number
  /** 实际带入的 seq 区间（可多段） */
  includedSeqs: Array<[number, number]>
  /** 被裁掉的 seq 区间（如实记录，不隐藏） */
  droppedSeqs: Array<[number, number]>
  /** 用了哪条摘要顶替（无压缩为 null） */
  summarySeq: number | null
  toolResultTrim: { trimmedCount: number; policy: string }
  keepRecentTurns: number
}

export interface BuiltContext {
  /** 给模型的消息（system 在最前；当前用户消息在最后） */
  messages: ModelMessage[]
  snapshot: ContextSnapshot
  estimatedTokens: number
  /** 是否需要先压缩（编排层据此调模型生成摘要，然后重新组装） */
  needsCompaction: boolean
  /** 要压缩掉的事件区间（含端点；无可压缩内容时为 null） */
  compactionRange: { fromSeq: number; toSeq: number } | null
}

export interface BuildContextInput {
  conversationId: string
  /** 当前使用的模型标识（决定窗口） */
  modelId: string
  /**
   * 直接给出窗口 token（可选）。
   *
   * 来源是后台模型配置里的**实测值**（`ai_models.context_window`）——有它就用它，
   * 比 tokenlens 的公开数据更准（自建网关上的私有模型 tokenlens 根本不认识）。
   */
  windowTokens?: number
  /** 该 agent 的系统提示词（渲染产物） */
  systemPrompt: string
  /** 本轮用户输入（参与估算） */
  userMessage: string
  /**
   * 本轮**附件的 token 成本**（没有附件就是 0）。
   *
   * 为什么由调用方算好传进来，而不是在这里自己读附件：附件内容要为模型**再读一次**对象存储
   * （context 只认数据结构、不碰存储），两边各读一次是纯浪费。调用方先按存储 key 取回并算出
   * 成本，这里只负责**让这份成本参与裁剪与压缩的判断**：
   * 不参与的话，一张图能让实际输入远超估算，我们会在"以为没超"的情况下把请求发出去挨上游 400。
   */
  extraInputTokens?: number
}

/**
 * 保守估算 token：中文按字、其它按 4 字符 ≈ 1 token。
 *
 * 本地没有各家 tokenizer，**裁剪预算一律用估算**（宁可多裁也不爆窗）；
 * 真实用量以 provider 返回的 `usage.inputTokens` 为准，两者都落库用于校准（见设计文档 §3.9 ⑥）。
 */
export const estimateTokens = (text: string): number => {
  let cjk = 0
  let other = 0
  for (const char of text) {
    if (char.charCodeAt(0) > 0x2e80) cjk += 1
    else other += 1
  }
  return cjk + Math.ceil(other / 4)
}

/** 一条消息段：要么是一条消息，要么是"工具调用 + 工具结果"这一对（配对不可拆） */
interface MessageSegment {
  messages: ModelMessage[]
  seqs: number[]
  tokens: number
  /** 属于哪一轮（轮号越小越旧；用于"最近 N 轮不裁"的保护） */
  turnIndex: number
}

/** 一条工具结果**给模型的视图**（累计预算会二次截断它；落库的原文不动） */
interface ResultPart {
  part: { type: string; toolCallId: string; toolName: string; output: unknown }
  /** 当前视图的文本（字符数就是预算口径） */
  text: string
  /** 它并进了哪个段（截断后要同步修正段的 token 估算） */
  segment: MessageSegment
}

/**
 * 上下文组装：把时间线还原成给模型的消息，并按「模型窗口的 70%」触发裁剪与压缩。
 *
 * 策略（详见设计文档 §3.9，全部可配）：
 *   正常 ≤70% → 直接用；>70% → 裁剪到 50%；仍装不下 → 压缩到 40%；再不行 → 兜底（system + 最近 1 轮）；
 *   仍超 → 抛 3307（**不硬塞**，硬塞会被上游 400）。
 *
 * 保护规则：系统提示词、最近 N 轮、当前用户输入、**工具调用与结果的配对**永不裁。
 * 取舍一律记进快照 —— 对模型可以省，对审计必须诚实。
 */
@Injectable()
export class ContextService {
  constructor(
    @Inject(TimelineRepository) private readonly timelines: TimelineRepository,
    @Inject(AgentConfig) private readonly config: AgentConfigValue,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}

  /** 三级解析模型窗口：配置覆盖 → tokenlens 注册表 → 保守默认（并打 warn，不静默） */
  resolveWindow(modelId: string): ContextWindowResolution {
    const override = this.config.contextModelWindows[modelId]
    if (override) return { windowTokens: override, source: 'config' }

    try {
      const info = getContextWindow(modelId)
      const tokens = info.inputMax ?? info.combinedMax ?? info.totalMax
      if (tokens && tokens > 0) {
        return { windowTokens: Math.trunc(tokens), source: 'registry' }
      }
    } catch {
      // 注册表查不到就落到默认值（下面会打 warn），不要在组装上下文时抛错
    }

    this.logger.warn('ai.context.window.unknown', {
      modelId,
      fallbackWindow: this.config.contextFallbackWindow,
    })
    return {
      windowTokens: this.config.contextFallbackWindow,
      source: 'fallback',
    }
  }

  /** 组装一次输入（不做压缩；需要压缩时通过 `needsCompaction` + `compactionRange` 告知编排层） */
  async buildInput(input: BuildContextInput): Promise<BuiltContext> {
    // 窗口优先级：后台配的实测值（`ai_models.context_window`）> tokenlens > 兜底值
    const window = input.windowTokens
      ? { windowTokens: input.windowTokens, source: 'provider' as const }
      : this.resolveWindow(input.modelId)
    const triggerTokens = Math.floor(window.windowTokens * this.config.contextTriggerRatio)
    const trimTargetTokens = Math.floor(window.windowTokens * this.config.contextTrimTargetRatio)
    // 兜底目标用压缩目标；真正"硬上限"是模型窗口本身
    const toolResultCharLimit = Math.max(
      256,
      Math.floor(
        window.windowTokens *
          this.config.contextToolResultMaxRatio *
          2 /* 1 token ≈ 2 字符的保守折算 */,
      ),
    )
    // 本轮所有工具结果的**累计**上限：单条上限随窗口线性放大，1M 窗口下等于不裁
    const toolResultTotalCharLimit = Math.max(
      256,
      Math.floor(window.windowTokens * this.config.contextToolResultTotalRatio * 2),
    )

    const summary = await this.timelines.latestSummary(input.conversationId)
    // 只看**根 run** 的事件：子 agent 的内部过程是审计资料，回灌给主模型既费窗口又污染上下文
    const events = await this.timelines.listSince(
      input.conversationId,
      summary?.seq ?? 0,
      MAX_EVENTS,
      { rootOnly: true },
    )

    const { segments, trimmedCount } = this.toSegments(events, {
      perResultChars: toolResultCharLimit,
      totalChars: toolResultTotalCharLimit,
    })

    // 基础消息：系统提示词 + （若有）摘要
    const systemMessages: ModelMessage[] = [{ role: 'system', content: input.systemPrompt }]
    if (summary) {
      const summaryText = typeof summary.payload?.text === 'string' ? summary.payload.text : ''
      systemMessages.push({
        role: 'system',
        content: `以下是早前对话的摘要（原文仍保留在系统里，必要时可要求回看）：\n${summaryText}`,
      })
    }
    const baseTokens = this.messagesTokens(systemMessages)
    // 本轮输入 = 用户文字 + 附件成本（附件成本由调用方按真实内容算好；没有附件就是 0）
    const extraInputTokens = Math.max(0, Math.trunc(input.extraInputTokens ?? 0))
    const userTokens = estimateTokens(input.userMessage) + 4 + extraInputTokens

    // 保护：最近 N 轮的起始轮号（轮号越小越旧）
    const lastTurnIndex = segments.length > 0 ? segments[segments.length - 1].turnIndex : 0
    const protectedFromTurn = Math.max(0, lastTurnIndex - (this.config.contextKeepRecentTurns - 1))

    const flush = (
      strategy: ContextSnapshot['strategy'],
      kept: MessageSegment[],
      dropped: MessageSegment[],
    ): BuiltContext => {
      const messages: ModelMessage[] = [
        ...systemMessages,
        ...kept.flatMap((segment) => segment.messages),
        { role: 'user', content: input.userMessage },
      ]
      const estimated = this.messagesTokens(messages) + extraInputTokens
      const snapshot: ContextSnapshot = {
        strategy,
        model: input.modelId,
        windowTokens: window.windowTokens,
        windowSource: window.source,
        triggerRatio: this.config.contextTriggerRatio,
        budgetTokens: triggerTokens,
        estimatedInputTokens: estimated,
        includedSeqs: this.toRanges(kept.flatMap((segment) => segment.seqs)),
        droppedSeqs: this.toRanges(dropped.flatMap((segment) => segment.seqs)),
        summarySeq: summary?.seq ?? null,
        toolResultTrim: {
          trimmedCount,
          policy: `maxCharsPerToolResult=${toolResultCharLimit};maxCharsPerTurnTotal=${toolResultTotalCharLimit}`,
        },
        keepRecentTurns: this.config.contextKeepRecentTurns,
      }
      return {
        messages,
        snapshot,
        estimatedTokens: estimated,
        needsCompaction: false,
        compactionRange: null,
      }
    }

    const totalTokens = (kept: MessageSegment[]): number =>
      baseTokens + userTokens + kept.reduce((sum, segment) => sum + segment.tokens, 0)

    // ① 正常：不超触发线，原样使用
    if (totalTokens(segments) <= triggerTokens) {
      return flush('window', segments, [])
    }

    // ② 裁剪：从最旧丢，直到 ≤ 裁剪目标；受保护的段（最近 N 轮）不动
    const kept: MessageSegment[] = [...segments]
    const dropped: MessageSegment[] = []
    for (const segment of segments) {
      if (totalTokens(kept) <= trimTargetTokens) break
      if (segment.turnIndex >= protectedFromTurn) break // 进入保护区，停止裁剪
      kept.shift()
      dropped.push(segment)
    }

    if (totalTokens(kept) <= triggerTokens) {
      return flush('trim', kept, dropped)
    }

    // ③ 压缩：裁剪解决不了 → 把**刚裁掉的那一段**交给模型做摘要（信息不丢，而不是丢掉）
    //    若压根没有可裁的内容（保护区自身就超线），压缩无从下手 → 直接进兜底
    const droppedSeqs = dropped.flatMap((segment) => segment.seqs)
    const compactionRange =
      droppedSeqs.length > 0
        ? {
            fromSeq: Math.min(...droppedSeqs),
            toSeq: Math.max(...droppedSeqs),
          }
        : null

    if (compactionRange) {
      const result = flush('trim+compact', kept, dropped)
      result.needsCompaction = true
      result.compactionRange = compactionRange
      return result
    }

    // ④ 兜底：连"最近 N 轮"都装不下 → 只留系统提示词 + 最近 1 轮
    const lastTurn = kept.filter((segment) => segment.turnIndex === lastTurnIndex)
    const minimal = baseTokens + userTokens + lastTurn.reduce((s, x) => s + x.tokens, 0)
    if (minimal > window.windowTokens) {
      // 不硬塞：硬塞会被上游 400，不如明确告诉调用方"上下文太长"
      throw new ContextTooLongError(minimal)
    }

    const fallbackDropped = kept.filter((segment) => segment.turnIndex !== lastTurnIndex)
    const result = flush('fallback', lastTurn, [...dropped, ...fallbackDropped])
    return result
  }

  /** 时间线事件 → 消息段（工具调用与结果配成一段；推理/步骤/来源等只审计、不进模型输入） */
  private toSegments(
    events: TimelineEntity[],
    limits: { perResultChars: number; totalChars: number },
  ): { segments: MessageSegment[]; trimmedCount: number } {
    const toolResultCharLimit = limits.perResultChars
    const segments: MessageSegment[] = []
    let turnIndex = 0
    let trimmedCount = 0
    /** 本轮所有工具结果给模型的视图（累计预算要从旧到新再压一层） */
    const resultParts: ResultPart[] = []
    /** toolCallId → 段索引（用于把 tool-result 并进对应的 tool-call 段） */
    const toolCallSegments = new Map<string, number>()

    for (const event of events) {
      if (event.kind === TimelineKind.System || event.kind === TimelineKind.Summary) {
        continue // 由调用方另行处理（系统提示词来自配置，摘要单独注入）
      }

      if (event.kind === TimelineKind.Text) {
        const text = typeof event.payload?.text === 'string' ? event.payload.text : ''
        if (!text) continue
        if (event.role === TimelineRole.User) turnIndex += 1
        const message: ModelMessage =
          event.role === TimelineRole.User
            ? { role: 'user', content: text }
            : { role: 'assistant', content: [{ type: 'text', text }] }
        segments.push({
          messages: [message],
          seqs: [event.seq],
          tokens: estimateTokens(text) + 4,
          turnIndex,
        })
        continue
      }

      if (event.kind === TimelineKind.ToolCall) {
        const toolCallId = event.toolCallId ?? ''
        const toolName = event.toolKey ?? 'unknown'
        const input = event.payload?.input ?? {}
        const message: ModelMessage = {
          role: 'assistant',
          content: [{ type: 'tool-call', toolCallId, toolName, input }],
        }
        toolCallSegments.set(toolCallId, segments.length)
        segments.push({
          messages: [message],
          seqs: [event.seq],
          tokens: estimateTokens(JSON.stringify(input)) + 8,
          turnIndex,
        })
        continue
      }

      if (event.kind === TimelineKind.ToolResult) {
        const toolCallId = event.toolCallId ?? ''
        const toolName = event.toolKey ?? 'unknown'
        const raw = event.payload?.output ?? null
        /**
         * **跨轮的分页视图**（设计 §5.6）：结果被分页过时，库里存的是 `{__toolPaged, page, data}`，
         * 模型这一轮看到的应当是**同一页**（第 1 页 + 页头 + 取页提示）—— 用与执行时**同一个纯函数**
         * 重算，保证前后逐字节一致（否则模型会看到"同一结果的两个不同开头"）。
         */
        if (isPagedToolValue(raw)) {
          const page = paginate(serializeToolValue(raw.data), raw.page.pageSize, 1, raw.page.handle)
          const view = JSON.stringify(toModelPage(page))
          const index = toolCallSegments.get(toolCallId)
          const part = {
            type: 'tool-result' as const,
            toolCallId,
            toolName,
            output: { type: 'json' as const, value: toModelPage(page) as never },
          }
          const resultMessage: ModelMessage = {
            role: 'tool',
            content: [part],
          }
          const tokenCost = estimateTokens(view) + 8
          if (index !== undefined) {
            segments[index].messages.push(resultMessage)
            segments[index].seqs.push(event.seq)
            segments[index].tokens += tokenCost
            resultParts.push({ part, text: view, segment: segments[index] })
          } else {
            const segment: MessageSegment = {
              messages: [resultMessage],
              seqs: [event.seq],
              tokens: tokenCost,
              turnIndex,
            }
            segments.push(segment)
            resultParts.push({ part, text: view, segment })
          }
          continue
        }
        const output = raw
        const serialized = JSON.stringify(output ?? null)
        const truncated = serialized.length > toolResultCharLimit
        if (truncated) trimmedCount += 1
        const modelText = truncated
          ? `${serialized.slice(0, toolResultCharLimit)}\n…[已截断，完整内容已入库]`
          : serialized
        const part = {
          type: 'tool-result' as const,
          toolCallId,
          toolName,
          // 超阈值时给模型"截断 + 明确提示"；**落库仍是完整原文**（设计文档 §4.6 保真原则）
          output: truncated
            ? { type: 'text' as const, value: modelText }
            : { type: 'json' as const, value: output as never },
        }
        const resultMessage: ModelMessage = {
          role: 'tool',
          content: [part],
        }
        const tokenCost =
          estimateTokens(truncated ? serialized.slice(0, toolResultCharLimit) : serialized) + 8
        const index = toolCallSegments.get(toolCallId)
        if (index !== undefined) {
          // 并进对应的 tool-call 段：配对永不拆开
          segments[index].messages.push(resultMessage)
          segments[index].seqs.push(event.seq)
          segments[index].tokens += tokenCost
          resultParts.push({ part, text: modelText, segment: segments[index] })
        } else {
          const segment: MessageSegment = {
            messages: [resultMessage],
            seqs: [event.seq],
            tokens: tokenCost,
            turnIndex,
          }
          segments.push(segment)
          resultParts.push({ part, text: modelText, segment })
        }
        continue
      }
      // 其余（reasoning / step / source / status / error）只用于审计与展示，不进模型输入
    }

    // 累计预算：单条都没超，但加起来超了 → 从**最旧**的开始再压一层
    trimmedCount += this.trimToolResultsByBudget(resultParts, limits.totalChars)
    return { segments, trimmedCount }
  }

  /**
   * 累计预算：本轮所有工具结果的字符总量超线时，把**较早**的那些再压一层。
   *
   * 为什么按"旧→新"：模型下一步最需要的是**刚刚**那次调用的结果，
   * 压旧的信息损失最小。最近 4 条一律不动（正在用的上下文）。
   * 只改给模型的视图；时间线里的出参仍由录制器全量落库，需要细节可重新调用 / 取回原文。
   */
  private trimToolResultsByBudget(parts: ResultPart[], totalChars: number): number {
    if (parts.length === 0) return 0
    let total = parts.reduce((sum, item) => sum + item.text.length, 0)
    if (total <= totalChars) return 0
    const keepRecent = 4
    const shrinkTo = Math.max(400, Math.floor(totalChars / Math.max(1, parts.length * 2)))
    let trimmed = 0
    for (let index = 0; index < parts.length && total > totalChars; index += 1) {
      if (index >= parts.length - keepRecent) break
      const item = parts[index]
      if (item.text.length <= shrinkTo) continue
      const nextText = `${item.text.slice(0, shrinkTo)}…[本轮工具结果超出上下文预算，已截断；完整内容已入库]`
      item.part.output = { type: 'text', value: nextText }
      item.segment.tokens += estimateTokens(nextText) - estimateTokens(item.text)
      total -= item.text.length - nextText.length
      item.text = nextText
      trimmed += 1
    }
    return trimmed
  }

  /**
   * 估算一组消息的 token。
   *
   * 多模态消息（带图片 / 文件的用户消息）**不能按 JSON 长度猜**：一张 2MB 图片转成 data URL
   * 后是几百万字符，按字符折算会得出"上下文已经爆了"的假结论，随即触发一次毫无必要的压缩
   * （压缩要真花钱）。所以媒体部分按**固定成本**计（各家视觉模型的图片计价差异很大，
   * 宁可估高一点：估高只会让我们更早裁历史，估低会直接被上游 400）。
   */
  private messagesTokens(messages: ModelMessage[]): number {
    let total = 0
    for (const message of messages) {
      total += this.contentTokens(message.content) + 4
    }
    return total
  }

  /**
   * 一条消息内容的 token：文本走字符折算、媒体 part 走固定成本。
   *
   * 规则本身在 `@repo/shared` 的 `estimateContentTokens`（同一份规则前端也要用：
   * 会话页要显示"这条消息大概占多少"）。这里只做 ModelMessage 层的外包。
   */
  private contentTokens(content: ModelMessage['content']): number {
    return estimateContentTokens(content)
  }

  /** 把零散 seq 合并成区间，便于审计阅读 */
  private toRanges(seqs: number[]): Array<[number, number]> {
    if (seqs.length === 0) return []
    const sorted = [...seqs].sort((a, b) => a - b)
    const ranges: Array<[number, number]> = []
    let [start, prev] = [sorted[0], sorted[0]]
    for (const seq of sorted.slice(1)) {
      if (seq === prev + 1) {
        prev = seq
        continue
      }
      ranges.push([start, prev])
      ;[start, prev] = [seq, seq]
    }
    ranges.push([start, prev])
    return ranges
  }
}
