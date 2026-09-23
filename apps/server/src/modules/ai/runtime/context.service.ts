import { Inject, Injectable } from '@nestjs/common'
import { AppLogger } from '@repo/kits'
import { TimelineKind, TimelineRole } from '@repo/shared'
import type { ModelMessage } from 'ai'
import { getContextWindow } from 'tokenlens'
import type { TimelineEntity } from '../../../database/entities/timeline-entity.js'
import {
  AgentConfig,
  type AgentConfig as AgentConfigValue,
} from '../core/ai.config.js'
import { ContextTooLongError } from '../core/ai.errors.js'
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
    const trimTargetTokens = Math.floor(
      window.windowTokens * this.config.contextTrimTargetRatio,
    )
    // 兜底目标用压缩目标；真正"硬上限"是模型窗口本身
    const toolResultCharLimit = Math.max(
      256,
      Math.floor(
        window.windowTokens *
          this.config.contextToolResultMaxRatio *
          2 /* 1 token ≈ 2 字符的保守折算 */,
      ),
    )

    const summary = await this.timelines.latestSummary(input.conversationId)
    // 只看**根 run** 的事件：子 agent 的内部过程是审计资料，回灌给主模型既费窗口又污染上下文
    const events = await this.timelines.listSince(
      input.conversationId,
      summary?.seq ?? 0,
      MAX_EVENTS,
      { rootOnly: true },
    )

    const { segments, trimmedCount } = this.toSegments(events, toolResultCharLimit)

    // 基础消息：系统提示词 + （若有）摘要
    const systemMessages: ModelMessage[] = [{ role: 'system', content: input.systemPrompt }]
    if (summary) {
      const summaryText =
        typeof summary.payload?.text === 'string' ? summary.payload.text : ''
      systemMessages.push({
        role: 'system',
        content: `以下是早前对话的摘要（原文仍保留在系统里，必要时可要求回看）：\n${summaryText}`,
      })
    }
    const baseTokens = this.messagesTokens(systemMessages)
    const userTokens = estimateTokens(input.userMessage) + 4

    // 保护：最近 N 轮的起始轮号（轮号越小越旧）
    const lastTurnIndex = segments.length > 0 ? segments[segments.length - 1].turnIndex : 0
    const protectedFromTurn = Math.max(
      0,
      lastTurnIndex - (this.config.contextKeepRecentTurns - 1),
    )

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
      const estimated = this.messagesTokens(messages)
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
          policy: `maxCharsPerToolResult=${toolResultCharLimit}`,
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
    toolResultCharLimit: number,
  ): { segments: MessageSegment[]; trimmedCount: number } {
    const segments: MessageSegment[] = []
    let turnIndex = 0
    let trimmedCount = 0
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
        const output = event.payload?.output ?? null
        const serialized = JSON.stringify(output ?? null)
        const truncated = serialized.length > toolResultCharLimit
        if (truncated) trimmedCount += 1
        const resultMessage: ModelMessage = {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId,
              toolName,
              // 超阈值时给模型"截断 + 明确提示"；**落库仍是完整原文**（设计文档 §4.6 保真原则）
              output: truncated
                ? {
                    type: 'text',
                    value: `${serialized.slice(0, toolResultCharLimit)}\n…[已截断，完整内容已入库]`,
                  }
                : { type: 'json', value: output as never },
            },
          ],
        }
        const tokenCost =
          estimateTokens(truncated ? serialized.slice(0, toolResultCharLimit) : serialized) + 8
        const index = toolCallSegments.get(toolCallId)
        if (index !== undefined) {
          // 并进对应的 tool-call 段：配对永不拆开
          segments[index].messages.push(resultMessage)
          segments[index].seqs.push(event.seq)
          segments[index].tokens += tokenCost
        } else {
          segments.push({
            messages: [resultMessage],
            seqs: [event.seq],
            tokens: tokenCost,
            turnIndex,
          })
        }
        continue
      }
      // 其余（reasoning / step / source / status / error）只用于审计与展示，不进模型输入
    }

    return { segments, trimmedCount }
  }

  private messagesTokens(messages: ModelMessage[]): number {
    let total = 0
    for (const message of messages) {
      if (typeof message.content === 'string') {
        total += estimateTokens(message.content) + 4
      } else {
        total += estimateTokens(JSON.stringify(message.content)) + 4
      }
    }
    return total
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
