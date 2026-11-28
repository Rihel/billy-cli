import type { AppLogger } from '@repo/kits'
import type { StreamPublisher, RunRecorder } from '../../engine/ports.js'
import type { RunRepository } from '../run/run.repository.js'
import type { AgUiEmitter } from '../stream/agui-emitter.js'
import { toolFailureOf } from '../stream/stream-recorder.js'
import { isCoalescedDelta } from '../stream/stream-deltas.js'
import type { StreamResponseLike } from '../stream/stream-response.js'

/** 进度写的节流间隔（ms） */
export const STREAM_PROGRESS_THROTTLE_MS = 1_000

/** 流式片段的最小结构（录制器与转发共用） */
export interface UiChunkLike {
  type?: string
  toolName?: string
  [key: string]: unknown
}

/**
 * 挂起块里的 `runId` 是 Mastra 的 engineRunId（`eng_...`）；前端回答时要调
 * `POST /agent/chat/resume`，参数必须是**应用 run id**。这里换掉并保留 engineRunId。
 */
export const normalizeSuspendedChunk = <T extends UiChunkLike>(chunk: T, runId: string): T => {
  if (chunk.type !== 'data-tool-call-suspended') return chunk
  const data = (chunk.data ?? {}) as Record<string, unknown>
  return {
    ...chunk,
    data: {
      ...data,
      engineRunId: data.runId ?? null,
      runId,
    },
  } as T
}

/** 客户端看到的那一份：`ok:false` 的工具结果按失败呈现（录制器仍拿原始片段） */
export const toClientToolChunk = <T extends UiChunkLike>(chunk: T): T => {
  // AI SDK 的 tool-input-available schema 要求 input 字段存在；上游在"空入参"时可能省略它，
  // JSON.stringify 又会把 undefined 丢掉，前端就报 Type validation failed。
  if (chunk.type === 'tool-input-available' && (chunk as { input?: unknown }).input === undefined) {
    return { ...chunk, input: null } as T
  }
  if (chunk.type !== 'tool-output-available') return chunk
  const failure = toolFailureOf((chunk as { output?: unknown }).output)
  if (!failure.failed) return chunk
  return {
    ...chunk,
    type: 'tool-output-error',
    errorText: failure.message ?? '工具报告失败（ok: false）',
  } as T
}

/** 一次 run 的 chunk 泵需要的能力 */
export interface TurnChunkPumpDeps {
  runId: string
  conversationId: string
  recorder: RunRecorder
  agui: AgUiEmitter
  streams: StreamPublisher
  runs: RunRepository
  logger: AppLogger
  response?: StreamResponseLike
  messageIdRef?: { value: string }
  /** 首段输出到达（撤首 token 看护） */
  onFirstToken?: () => void
}

/**
 * 一轮的 chunk 泵：**录制 + 发射 + 进度**的唯一实现。
 *
 * 首轮与无头队列两条路径共用；续跑路径的 emit / record 顺序不同（先发后录），
 * 暂不接入 —— 它有自己的 `resumeSafeChunks` 语义，混进来只会更难读。
 *
 * 纪律：
 * - 先给客户端，再落库（用户的体感不该被落库拖慢），由 `onOutgoing` 回调实现；
 * - 增量块不进闸门、不等 Redis（录制器只在 part 结束时落库）；
 * - 录制失败只记日志，不掐断用户正在看的流。
 */
export class TurnChunkPump {
  rev = 0
  stepCount = 0
  suspended = false
  private lastProgressAt = 0

  constructor(private readonly deps: TurnChunkPumpDeps) {}

  /** 处理一个原始 chunk；`onOutgoing` 在落库之前调用（流式路径用它写响应体） */
  async consume(
    chunk: UiChunkLike,
    onOutgoing?: (chunk: UiChunkLike) => void,
  ): Promise<UiChunkLike> {
    // 第一段输出到了：撤掉首 token 看护（文本 / 推理 / 工具入参都算"模型动了"）
    if (
      chunk.type === 'text-delta' ||
      chunk.type === 'reasoning-delta' ||
      chunk.type === 'tool-input-available'
    ) {
      this.deps.onFirstToken?.()
    }
    // 挂起是这一轮的"暂停"，不是成功；收尾分支据此决定 finish 还是 suspend。
    if (chunk.type === 'data-tool-call-suspended') this.suspended = true
    const recordedChunk = normalizeSuspendedChunk(chunk, this.deps.runId)
    // 客户端看到的那一份：`ok:false` 的结果按失败呈现（录制器仍拿原始片段，出参全量入库）
    const outgoing = toClientToolChunk(recordedChunk)
    onOutgoing?.(outgoing)
    try {
      /**
       * 闸门要在**落时间线之前**等：先落库再等，补发可能把这条已闭合 part 读进快照，
       * 闸门放开后实时又发一遍 → 重复。
       *
       * 但**增量块不落时间线**（录制器只在 part 结束时落库），所以它们既不用等闸门、
       * 也不用每 token 一次 Redis 往返 —— 直接进合并器，由 flush 统一处理。
       */
      if (!isCoalescedDelta(outgoing)) await this.deps.streams.waitForReplayGate(this.deps.runId)
      await this.deps.recorder.consume(recordedChunk)
      this.rev = await this.deps.agui.emit({
        runId: this.deps.runId,
        threadId: this.deps.conversationId,
        chunk: outgoing,
        ...(this.deps.response ? { response: this.deps.response } : {}),
        ...(this.deps.messageIdRef ? { messageIdRef: this.deps.messageIdRef } : {}),
      })
      if (chunk.type === 'start-step') this.stepCount += 1
      const nowMs = Date.now()
      if (nowMs - this.lastProgressAt >= STREAM_PROGRESS_THROTTLE_MS) {
        this.lastProgressAt = nowMs
        await this.deps.streams.patchRun(this.deps.runId, {
          stage:
            chunk.type === 'tool-input-available' ? `tool:${chunk.toolName ?? ''}` : 'generating',
          rev: this.rev,
          step: this.stepCount,
          heartbeatAt: new Date().toISOString(),
        })
        await this.deps.runs.touchHeartbeat(this.deps.runId)
      }
    } catch (error) {
      // 录制失败不掐断用户正在看的流：记日志继续（真相仍在，稍后可补）
      this.deps.logger.warn('ai.stream.record_failed', {
        runId: this.deps.runId,
        reason: error instanceof Error ? error.message : String(error),
      })
    }
    return outgoing
  }
}
