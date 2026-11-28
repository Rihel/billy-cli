import { Inject, Injectable, Optional } from '@nestjs/common'
import { AppLogger, Telemetry } from '@repo/kits'

/** `engine.run.start` 的字段（设计 §13） */
export interface EngineRunStartFields {
  runId?: string
  taskId?: string | null
  conversationId?: string
  agentKey?: string
  model?: string
  phase: 'start' | 'resume' | 'recover'
}

/** `engine.run.finish` 的字段 */
export interface EngineRunFinishFields {
  runId: string
  status: string
  stopReason?: string
  durationMs: number
  usage?: unknown
}

/**
 * 引擎观测：事件走 logger（可检索），指标走 `Telemetry`（窗口聚合）。
 *
 * 指标名统一 `engine_` 前缀，避免与 HTTP / 业务指标混在一起：
 * - `engine_run_start` / `engine_run_finish` / `engine_run_succeeded` / `engine_run_failed`
 * - `engine_conversation_busy`：同会话并发被挡（409）次数
 * - `engine_active_runs`：当前进程内活跃 run 数（gauge）
 * - `engine_run_duration_ms` / `engine_first_token_ms`：耗时直方图
 */
@Injectable()
export class EngineTelemetry {
  constructor(
    @Inject(Telemetry) private readonly telemetry: Telemetry,
    @Optional() @Inject(AppLogger) private readonly logger?: AppLogger,
  ) {}

  start(fields: EngineRunStartFields): void {
    this.logger?.log('engine.run.start', {
      phase: fields.phase,
      ...(fields.runId ? { runId: fields.runId } : {}),
      ...(fields.taskId ? { taskId: fields.taskId } : {}),
      ...(fields.conversationId ? { conversationId: fields.conversationId } : {}),
      ...(fields.agentKey ? { agentKey: fields.agentKey } : {}),
      ...(fields.model ? { model: fields.model } : {}),
    })
    this.telemetry.incr('engine_run_start')
  }

  finish(fields: EngineRunFinishFields): void {
    this.logger?.log('engine.run.finish', {
      runId: fields.runId,
      status: fields.status,
      ...(fields.stopReason ? { stopReason: fields.stopReason } : {}),
      durationMs: fields.durationMs,
    })
    this.telemetry.incr('engine_run_finish')
    if (fields.status === 'succeeded') this.telemetry.incr('engine_run_succeeded')
    else this.telemetry.incr('engine_run_failed')
    this.telemetry.histogram('engine_run_duration_ms', Math.max(0, fields.durationMs))
  }

  suspend(fields: { runId: string; toolCallId?: string; reason?: string }): void {
    this.logger?.log('engine.run.suspend', fields)
    this.telemetry.incr('engine_run_suspended')
  }

  recover(fields: { runId: string; result: 'recovered' | 'interrupted' | 'failed' }): void {
    this.logger?.log('engine.run.recover', fields)
    this.telemetry.incr(
      fields.result === 'recovered'
        ? 'engine_run_recovered'
        : fields.result === 'interrupted'
          ? 'engine_run_interrupted'
          : 'engine_run_recover_failed',
    )
  }

  streamError(fields: { runId: string; stage: string; message: string }): void {
    this.logger?.warn('engine.stream.error', fields)
    this.telemetry.incr('engine_stream_error')
  }

  firstToken(durationMs: number): void {
    this.telemetry.histogram('engine_first_token_ms', Math.max(0, durationMs))
  }

  /** 断线补发耗时（从合闸门到写完快照 + 增量） */
  replay(durationMs: number, replayed: boolean): void {
    this.telemetry.histogram('engine_replay_ms', Math.max(0, durationMs))
    this.telemetry.incr(replayed ? 'engine_replay_served' : 'engine_replay_empty')
  }

  busy(): void {
    this.telemetry.incr('engine_conversation_busy')
  }

  activeRuns(count: number): void {
    this.telemetry.gauge('engine_active_runs', count)
  }
}
