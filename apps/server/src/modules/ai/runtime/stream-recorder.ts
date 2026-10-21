import { TimelineKind, TimelineRole, ToolResultState } from '@repo/shared'
import type { ToolCallMeta, ToolCallMetaStore } from '../core/tools/tool.meta.js'
import { toPlanPayload } from './plan.protocol.js'
import type { TimelineRepository } from './timeline.repository.js'

/** AI SDK UI Message Stream 的片段（只取我们关心的字段，避免把它的联合类型铺满本文件） */
interface ChunkLike {
  type?: string
  id?: string
  delta?: string
  messageId?: string
  toolCallId?: string
  toolName?: string
  input?: unknown
  output?: unknown
  errorText?: string
  data?: unknown
}

/** Mastra step 结果的最小结构（流结束后用它补步骤行） */
export interface StepLikeLite {
  usage?: unknown
  finishReason?: string
}

export interface RecorderContext {
  conversationId: string
  runId: string
}

/** 录制器的可选项（审计与"未知工具"标记都要它） */
export interface RecorderOptions {
  /** 一次工具调用的审计旁证（网关写的；写 `tool-result` 行时按 toolCallId 取走） */
  metas?: ToolCallMetaStore
  /** 工具 key 是否在注册表里（不在 = 模型编出来的名字，落一个可排查的 state） */
  isKnownTool?: (toolKey: string) => boolean
}

/**
 * 流式录制器：把 UI Message Stream 的片段累积成时间线事件。
 *
 * 落库时机（控制写放大，同时保证"刷新不丢"）：
 * - **每个 part 完成即落一行**：文本 / 推理在 `*-end` 落；工具调用在 `tool-input-available` 落；
 *   工具结果在 `tool-output-available` / `tool-output-error` 落；错误即时落；
 * - **流式增量不落库**（增量只在内存累积 + Redis 输出记录里，供断线补发）；
 * - **步骤行在流结束后补齐**（每步的 token 用量只有结束时才知道），作为"本步开销"标记。
 *
 * 这是**每个运行一个实例**的普通类（由编排层手工 new，不经容器，故不写装饰器）。
 */
export class StreamRecorder {
  /** 文本片段：id → 累积内容 */
  private readonly texts = new Map<string, string>()
  /** 推理片段：id → 累积内容 */
  private readonly reasonings = new Map<string, string>()
  /**
   * 推理片段：id → **开始时间**（毫秒）。
   *
   * 为什么单独记：思考行要能显示"思考了 N 秒"。结束时间落库时是 `Date.now()`，
   * 但开始时间不在事件里 —— 不记的话历史里的思考块只能显示"思考完成"（前端不编造秒数）。
   */
  private readonly reasoningStartedAt = new Map<string, number>()
  /**
   * toolCallId → 工具 key。
   *
   * AI SDK v6 的 `tool-input-available` 带 `toolName`，但 `tool-output-available` **只有
   * toolCallId**（实测）。不把工具名从入参那一步记下来，工具结果行就会 `tool_key = null`
   * （审计里认不出这是哪个工具），依赖工具名的识别（如 `plan` 事件）也永远不成立。
   */
  private readonly toolNames = new Map<string, string>()
  private messageId = ''
  private toolCallCount = 0
  private errorText: string | null = null

  constructor(
    private readonly timelines: TimelineRepository,
    private readonly ctx: RecorderContext,
    private readonly options: RecorderOptions = {},
  ) {}

  /** 记一个片段；未知类型忽略（start/finish/data-* 等不影响落库完整性） */
  async consume(chunk: ChunkLike): Promise<void> {
    switch (chunk.type) {
      case 'start':
        this.messageId = chunk.messageId ?? ''
        return
      case 'text-start':
        this.texts.set(chunk.id ?? '', '')
        return
      case 'text-delta':
        this.texts.set(chunk.id ?? '', (this.texts.get(chunk.id ?? '') ?? '') + (chunk.delta ?? ''))
        return
      case 'text-end':
        await this.flushText(chunk.id ?? '')
        return
      case 'reasoning-start':
        this.reasonings.set(chunk.id ?? '', '')
        this.reasoningStartedAt.set(chunk.id ?? '', Date.now())
        return
      case 'reasoning-delta':
        // 有些提供方不发 `reasoning-start`：第一次见到增量时补记开始时间
        if (!this.reasoningStartedAt.has(chunk.id ?? '')) {
          this.reasoningStartedAt.set(chunk.id ?? '', Date.now())
        }
        this.reasonings.set(
          chunk.id ?? '',
          (this.reasonings.get(chunk.id ?? '') ?? '') + (chunk.delta ?? ''),
        )
        return
      case 'reasoning-end':
        await this.flushReasoning(chunk.id ?? '')
        return
      case 'tool-input-available':
        this.toolCallCount += 1
        if (chunk.toolCallId) this.toolNames.set(chunk.toolCallId, chunk.toolName ?? '')
        await this.append({
          role: TimelineRole.Assistant,
          kind: TimelineKind.ToolCall,
          toolKey: chunk.toolName ?? null,
          toolCallId: chunk.toolCallId ?? null,
          // **入参完整落库，不裁剪**
          payload: {
            toolCallId: chunk.toolCallId ?? null,
            toolName: chunk.toolName ?? null,
            input: chunk.input ?? null,
          },
        })
        return
      case 'data-tool-call-suspended': {
        // 挂起也是"过程事实"：刷新 / 换设备后要靠这一行把问题卡重建出来。
        // 它不是 tool-result（工具还没返回），所以单独一种 kind，别和结果混在一起。
        const data = (chunk.data ?? {}) as Record<string, unknown>
        // `resumed=true` 是"同一个挂起点继续"，不是新的一次挂起；再写一行会重复，
        // 也会让历史重建出两张问题卡。但工具名要记下：后面 tool-output-available
        // 只给 toolCallId，不补名字结果行的 tool_key 就是 null。
        if (data.resumed === true) {
          if (typeof data.toolCallId === 'string' && typeof data.toolName === 'string') {
            this.toolNames.set(data.toolCallId, data.toolName)
          }
          return
        }
        await this.append({
          role: TimelineRole.Assistant,
          kind: TimelineKind.ToolSuspended,
          toolKey: typeof data.toolName === 'string' ? data.toolName : null,
          toolCallId: typeof data.toolCallId === 'string' ? data.toolCallId : null,
          payload: {
            toolCallId: data.toolCallId ?? null,
            toolName: data.toolName ?? null,
            // 前端回答时调 `/agent/chat/resume`，要的是**应用 run id**；
            // Mastra 的 `data.runId` 是 engineRunId（eng_...），放另一个字段留审计。
            runId: this.ctx.runId,
            engineRunId: data.engineRunId ?? null,
            suspendPayload: data.suspendPayload ?? null,
            resumeSchema: data.resumeSchema ?? null,
          },
        })
        return
      }
      case 'tool-output-available': {
        // 结果片段不带工具名（AI SDK v6 只给 toolCallId）→ 用入参那一步记下的名字补上
        const toolName = chunk.toolName ?? this.toolNameOf(chunk.toolCallId)
        const meta = this.takeMeta(chunk.toolCallId)
        await this.append({
          role: TimelineRole.Assistant,
          kind: TimelineKind.ToolResult,
          state: ToolResultState._source.Available.value,
          toolKey: toolName,
          toolCallId: chunk.toolCallId ?? null,
          payload: {
            toolCallId: chunk.toolCallId ?? null,
            toolName,
            // **出参完整落库，不裁剪**（分页只改"给模型那一份"，见设计 §5.6）
            output: chunk.output ?? null,
            isError: false,
            ...(meta ? { outcome: meta } : {}),
          },
        })
        // 规划能力：四个规划工具的输出都额外落一条 `plan` 事件（当前计划 = 最后一条 plan 事件）
        const plan = toPlanPayload(toolName, chunk.output)
        if (plan) {
          await this.append({
            role: TimelineRole.Assistant,
            kind: TimelineKind.Plan,
            payload: plan as unknown as Record<string, unknown>,
          })
        }
        return
      }
      case 'tool-output-error': {
        const toolName = chunk.toolName ?? this.toolNameOf(chunk.toolCallId)
        const errorText = chunk.errorText ?? null
        // 模型编了个不存在的工具：上游把它落成工具错误结果（整轮不失败）。这里**单独标一个 state**，
        // 让它在时间线上可查、可计数 —— 这是"提示词与工具面不一致"的信号（设计 §5.4）
        const unknownTool =
          Boolean(toolName) && this.options.isKnownTool ? !this.options.isKnownTool(toolName!) : false
        const meta = this.takeMeta(chunk.toolCallId)
        await this.append({
          role: TimelineRole.Assistant,
          kind: TimelineKind.ToolResult,
          state: unknownTool
            ? ToolResultState._source.UnknownTool.value
            : ToolResultState._source.Error.value,
          toolKey: toolName,
          toolCallId: chunk.toolCallId ?? null,
          payload: {
            toolCallId: chunk.toolCallId ?? null,
            toolName,
            output: null,
            isError: true,
            errorText,
            ...(unknownTool ? { reason: 'unknown-tool' } : {}),
            ...(meta ? { outcome: meta } : {}),
          },
        })
        return
      }
      case 'tool-input-error':
        await this.append({
          role: TimelineRole.Assistant,
          kind: TimelineKind.Error,
          payload: {
            toolCallId: chunk.toolCallId ?? null,
            toolName: chunk.toolName ?? null,
            stage: 'tool',
            errorText: chunk.errorText ?? null,
            input: chunk.input ?? null,
          },
        })
        return
      case 'error':
        this.errorText = chunk.errorText ?? '未知错误'
        await this.append({
          role: TimelineRole.System,
          kind: TimelineKind.Error,
          payload: { stage: 'stream', message: this.errorText },
        })
        return
      case 'data-status':
        await this.append({
          role: TimelineRole.System,
          kind: TimelineKind.Status,
          payload: (chunk.data ?? {}) as Record<string, unknown>,
        })
        return
      default:
        // start/finish/start-step/finish-step 以及未知 data-* 不落行：步骤行在 finish() 里统一补
        return
    }
  }

  /**
   * 把还没收到 `*-end` 的文本 / 推理也落库。
   *
   * 用途：用户中途停止、或流被中断时，**已经生成并展示给用户的内容不能丢**
   * （否则"我看过的那半句"在历史里查不到，复盘也对不上）。
   */
  async flushPending(): Promise<void> {
    for (const id of [...this.texts.keys()]) await this.flushText(id)
    for (const id of [...this.reasonings.keys()]) await this.flushReasoning(id)
  }

  /**
   * 流结束后补步骤行（每步的 token 与结束原因）。
   *
   * `steps` 允许缺失（`undefined` / 非数组）：调用方读不到步级元数据时按"没有步骤行"处理。
   * 这里必须自己兜住 —— 早先直接 `steps.entries()`，durable 形态下 `steps` 是 `undefined`，
   * 异常把**已经跑完并展示给用户的一轮**判成 failed（用户看到"回答出来了但运行失败"）。
   */
  async finish(
    steps: StepLikeLite[] | undefined | null,
  ): Promise<{ toolCallCount: number; errorText: string | null }> {
    for (const [index, step] of (Array.isArray(steps) ? steps : []).entries()) {
      await this.append({
        role: TimelineRole.Assistant,
        kind: TimelineKind.Step,
        usage: (step.usage ?? null) as Record<string, unknown> | null,
        payload: { stepIndex: index, finishReason: step.finishReason ?? null },
      })
    }
    return { toolCallCount: this.toolCallCount, errorText: this.errorText }
  }

  /**
   * 取走这次调用的审计旁证（网关写的）。
   *
   * 为什么要"取走"而不是"读"：同一次工具调用只会有一条 `tool-result` 行，
   * 取走即删避免崩溃恢复重放时把上一轮的旁证贴到新一轮上。
   */
  private takeMeta(toolCallId: string | undefined): ToolCallMeta | null {
    if (!toolCallId || !this.options.metas) return null
    return this.options.metas.take(this.ctx.runId, toolCallId)
  }

  /** 由 toolCallId 找回工具 key（结果片段不带工具名，见 `toolNames` 的注释） */
  private toolNameOf(toolCallId: string | undefined): string | null {
    if (!toolCallId) return null
    const name = this.toolNames.get(toolCallId)
    return name ? name : null
  }

  private async flushText(id: string): Promise<void> {    const text = (this.texts.get(id) ?? '').trim()
    this.texts.delete(id)
    if (!text) return
    await this.append({
      role: TimelineRole.Assistant,
      kind: TimelineKind.Text,
      payload: { text },
    })
  }

  private async flushReasoning(id: string): Promise<void> {
    const text = (this.reasonings.get(id) ?? '').trim()
    const startedAt = this.reasoningStartedAt.get(id)
    this.reasonings.delete(id)
    this.reasoningStartedAt.delete(id)
    if (!text) return
    const finishedAt = Date.now()
    await this.append({
      role: TimelineRole.Assistant,
      kind: TimelineKind.Reasoning,
      payload: { text },
      // 真实时长（前端据此显示"思考了 N 秒"；拿不到就不写，界面显示"思考完成"而不是假数字）
      ...(startedAt !== undefined
        ? { startedAt: new Date(startedAt), finishedAt: new Date(finishedAt), durationMs: Math.max(0, finishedAt - startedAt) }
        : {}),
    })
  }

  private async append(data: {
    role: string
    kind: string
    state?: string
    toolKey?: string | null
    toolCallId?: string | null
    usage?: Record<string, unknown> | null
    payload: Record<string, unknown>
    /** 覆盖开始/结束时间与时长（思考行用它记"思考了多久"；缺省 = 就是"现在这一刻"） */
    startedAt?: Date
    finishedAt?: Date
    durationMs?: number
  }): Promise<void> {
    const now = data.finishedAt ?? new Date()
    await this.timelines.append({
      conversationId: this.ctx.conversationId,
      runId: this.ctx.runId,
      messageId: this.messageId,
      role: data.role,
      kind: data.kind,
      state: data.state ?? null,
      toolKey: data.toolKey ?? null,
      toolCallId: data.toolCallId ?? null,
      usage: data.usage ?? null,
      payload: data.payload,
      startedAt: data.startedAt ?? now,
      finishedAt: now,
      ...(data.durationMs !== undefined ? { durationMs: data.durationMs } : {}),
    })
  }
}
