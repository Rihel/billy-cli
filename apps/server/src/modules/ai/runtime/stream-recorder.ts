import { TimelineKind, TimelineRole } from '@repo/shared'
import { toPlanPayload } from './plan.js'
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
  private messageId = ''
  private toolCallCount = 0
  private errorText: string | null = null

  constructor(
    private readonly timelines: TimelineRepository,
    private readonly ctx: RecorderContext,
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
        return
      case 'reasoning-delta':
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
      case 'tool-output-available': {
        await this.append({
          role: TimelineRole.Assistant,
          kind: TimelineKind.ToolResult,
          state: 'output-available',
          toolKey: chunk.toolName ?? null,
          toolCallId: chunk.toolCallId ?? null,
          payload: {
            toolCallId: chunk.toolCallId ?? null,
            toolName: chunk.toolName ?? null,
            // **出参完整落库，不裁剪**
            output: chunk.output ?? null,
            isError: false,
          },
        })
        // 规划能力：write-plan 的输出额外落一条 `plan` 事件（当前计划 = 最后一条）
        const plan = toPlanPayload(chunk.toolName ?? null, chunk.output)
        if (plan) {
          await this.append({
            role: TimelineRole.Assistant,
            kind: TimelineKind.Plan,
            payload: plan as unknown as Record<string, unknown>,
          })
        }
        return
      }
      case 'tool-output-error':
        await this.append({
          role: TimelineRole.Assistant,
          kind: TimelineKind.ToolResult,
          state: 'output-error',
          toolKey: chunk.toolName ?? null,
          toolCallId: chunk.toolCallId ?? null,
          payload: {
            toolCallId: chunk.toolCallId ?? null,
            toolName: chunk.toolName ?? null,
            output: null,
            isError: true,
            errorText: chunk.errorText ?? null,
          },
        })
        return
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

  /** 流结束后补步骤行（每步的 token 与结束原因） */
  async finish(steps: StepLikeLite[]): Promise<{ toolCallCount: number; errorText: string | null }> {
    for (const [index, step] of steps.entries()) {
      await this.append({
        role: TimelineRole.Assistant,
        kind: TimelineKind.Step,
        usage: (step.usage ?? null) as Record<string, unknown> | null,
        payload: { stepIndex: index, finishReason: step.finishReason ?? null },
      })
    }
    return { toolCallCount: this.toolCallCount, errorText: this.errorText }
  }

  private async flushText(id: string): Promise<void> {
    const text = (this.texts.get(id) ?? '').trim()
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
    this.reasonings.delete(id)
    if (!text) return
    await this.append({
      role: TimelineRole.Assistant,
      kind: TimelineKind.Reasoning,
      payload: { text },
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
  }): Promise<void> {
    const now = new Date()
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
      startedAt: now,
      finishedAt: now,
    })
  }
}
