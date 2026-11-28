import { Inject, Injectable, Optional } from '@nestjs/common'
import { AppLogger } from '@repo/kits'
import { RunStatus, type AgentRunSnapshotModel, type AgentRunStopResultModel } from '@repo/shared'
import type { RunEntity } from '@repo/db'
import { AgentConfig, type AgentConfig as AgentConfigValue } from '../foundation/config.js'
import { AgentChatService } from '../runtime/agent/chat.service.js'
import { RunRepository } from '../runtime/run/run.repository.js'
import {
  UI_STREAM_HEADERS,
  endSse,
  sseFrame,
  writeSse,
  type StreamResponseLike,
} from '../runtime/stream/stream-response.js'
import { engineError, toEngineError } from './engine-errors.js'
import { EngineTelemetry } from './engine-telemetry.js'
import { isTerminalRunState } from './run-state.js'
import type {
  AttachRunCommand,
  EngineCaller,
  ResumeRunCommand,
  SnapshotRunCommand,
  StartRunCommand,
  StopRunCommand,
} from './protocol.js'
import { RunEventSink, type RunExecution, type RunOutcome } from './run-execution.js'
import { STREAM_END_MARKER } from '../runtime/stream/stream-response.js'

/** 引擎侧看到的 run 身份（建 run 后立即拿到，不等准备阶段） */
interface RunRef {
  id: string
  conversationId: string
  taskId: string | null
}

/** SSE 心跳间隔（必须显著小于网关空闲超时；与执行体同一口径） */
const PUMP_HEARTBEAT_MS = 15_000

/**
 * Engine 的执行入口（Host 适配器）。
 *
 * 两种模式（`AGENT_ENGINE_V2`）：
 * - **v2（默认）**：`start` / `resume` 返回 `RunExecution`（事件流 + 结果），
 *   controller 只消费事件；记录 / 收尾仍由执行体完成，wire format 不变。
 * - **v1（回退）**：直接把命令转给 `AgentChatService`，沿用旧的直写 response 路径。
 *
 * 为什么保留 v1：灰度期需要一键回退。两条路径复用同一份执行体，行为等价。
 */
@Injectable()
export class RunExecutor {
  constructor(
    @Inject(AgentChatService) private readonly chat: AgentChatService,
    // 以下三个在手工构造（测试 / 脚本）时可以缺省：缺省 = 关闭 v2、走直写路径
    @Optional() @Inject(RunRepository) private readonly runs?: RunRepository,
    @Optional() @Inject(AgentConfig) private readonly config?: AgentConfigValue,
    @Optional() @Inject(AppLogger) private readonly logger?: AppLogger,
    @Optional() @Inject(EngineTelemetry) private readonly telemetry?: EngineTelemetry,
  ) {}

  /** 本进程内活跃 run（指标与卡死排查） */
  private readonly activeRuns = new Set<string>()

  /** 非流式一轮（保持旧入口语义） */
  startOnce(caller: EngineCaller, command: StartRunCommand) {
    return this.chat.chat(caller.id, command.input, caller.isAdmin)
  }

  /** 流式一轮：v2 走 RunExecution，v1 直写 response */
  async startStream(
    caller: EngineCaller,
    command: StartRunCommand,
    response: StreamResponseLike,
  ): Promise<void> {
    if (!this.config?.engineV2) {
      return this.chat.chatStream(
        caller.id,
        command.input,
        response,
        caller.isAdmin,
        command.clientId,
      )
    }
    const execution = await this.start(caller, command)
    await this.pump(execution, response)
  }

  /** 续跑挂起的一轮 */
  async resumeStream(
    caller: EngineCaller,
    command: ResumeRunCommand,
    response: StreamResponseLike,
  ): Promise<void> {
    if (!this.config?.engineV2) {
      return this.chat.resumeChat(
        caller.id,
        command.input,
        response,
        caller.isAdmin,
        command.clientId,
      )
    }
    const execution = await this.resume(caller, command)
    await this.pump(execution, response)
  }

  /** 启动一轮并返回执行句柄（Host 可以自己消费事件） */
  async start(caller: EngineCaller, command: StartRunCommand): Promise<RunExecution> {
    const sink = new RunEventSink()
    const created = this.deferredRef()
    const task = this.chat.chatStream(
      caller.id,
      command.input,
      sink,
      caller.isAdmin,
      command.clientId ?? command.input.clientId,
      (run) => created.resolve(run),
    )
    // 建 run 之前就失败（会话不存在 / 无权）：把错误交给 created，start() 直接抛
    task.catch((error: unknown) => {
      if (toEngineError(error).code === 'conversation_busy') this.telemetry?.busy()
      created.reject(error)
    })
    return this.toExecution(caller, sink, task, created.promise, {
      phase: 'start',
      ...(command.input.conversationId ? { conversationId: command.input.conversationId } : {}),
      ...(command.input.agentKey ? { agentKey: command.input.agentKey } : {}),
    })
  }

  /** 续跑并返回执行句柄 */
  async resume(caller: EngineCaller, command: ResumeRunCommand): Promise<RunExecution> {
    const sink = new RunEventSink()
    const created = this.deferredRef()
    const task = this.chat.resumeChat(
      caller.id,
      command.input,
      sink,
      caller.isAdmin,
      command.clientId ?? command.input.clientId,
      (run) => created.resolve(run),
    )
    task.catch((error: unknown) => created.reject(error))
    return this.toExecution(caller, sink, task, created.promise, {
      phase: 'resume',
      runId: command.input.runId,
    })
  }

  /** 停止当前轮 / 指定 run（幂等） */
  stop(caller: EngineCaller, command: StopRunCommand): Promise<AgentRunStopResultModel> {
    return this.chat.stopRun(caller.id, command.input)
  }

  /** 快照：按 runId 或 conversationId */
  snapshot(
    caller: EngineCaller,
    command: SnapshotRunCommand,
  ): Promise<AgentRunSnapshotModel | null> {
    if (command.runId) return this.chat.snapshotRun(caller.id, command.runId)
    return this.chat.snapshotCurrentRun(caller.id, command.conversationId)
  }

  /** 重连：没有可续的流返回 false（controller 回 204） */
  attach(
    caller: EngineCaller,
    command: AttachRunCommand,
    response: StreamResponseLike,
  ): Promise<boolean> {
    if (command.runId) {
      return this.chat.resumeRun(
        caller.id,
        command.runId,
        command.sinceRev,
        response,
        command.clientId,
      )
    }
    return this.chat.resumeCurrentRun(
      caller.id,
      command.sinceRev,
      response,
      command.conversationId,
      command.clientId,
    )
  }

  /** 把执行句柄的事件泵到 SSE 响应（controller 用） */
  private async pump(execution: RunExecution, response: StreamResponseLike): Promise<void> {
    let headed = false
    let heartbeat: NodeJS.Timeout | undefined
    const ensureHead = (): void => {
      if (headed) return
      headed = true
      response.writeHead(200, UI_STREAM_HEADERS)
      response.flushHeaders?.()
      response.on?.('error', () => undefined)
    }
    const stopHeartbeat = (): void => {
      if (!heartbeat) return
      clearInterval(heartbeat)
      heartbeat = undefined
    }
    try {
      for await (const event of execution.events) {
        ensureHead()
        writeSse(response, sseFrame(event))
        if ((event as { type?: string }).type === STREAM_END_MARKER) continue
        if (!heartbeat) {
          // 执行体自己也会写 `: ping` 到 sink（被收进事件队列后丢弃），这里只保证
          // 长准备阶段 / 模型安静期也有注释帧，客户端与网关都不会判空闲断流。
          heartbeat = setInterval(() => {
            if (response.writableEnded) return
            writeSse(response, ': ping\n\n')
          }, PUMP_HEARTBEAT_MS)
          heartbeat.unref?.()
        }
      }
      await execution.result
    } catch (error) {
      const mapped = toEngineError(error)
      // 响应头还没发：这一轮根本没建流，错误必须抛回 HTTP（业务错误码要能被前端看到）
      if (!headed) throw error
      this.logger?.warn('ai.engine.stream_failed', {
        runId: execution.runId,
        code: mapped.code,
        message: mapped.message,
      })
      this.telemetry?.streamError({
        runId: execution.runId,
        stage: 'pump',
        message: mapped.message,
      })
    } finally {
      stopHeartbeat()
      if (headed) endSse(response)
    }
  }

  /** 组装执行句柄：事件流、结果、abort */
  private async toExecution(
    caller: EngineCaller,
    sink: RunEventSink,
    task: Promise<void>,
    created: Promise<RunRef>,
    fields: {
      phase: 'start' | 'resume' | 'recover'
      runId?: string
      conversationId?: string
      agentKey?: string
    },
  ): Promise<RunExecution> {
    // 建 run 前的失败原样抛回：业务错误码（3406 / 3304 …）是 wire format 的一部分，
    // 包成 EngineError 会让前端只能看到 500（设计 §2.3「不破坏现有 wire format」）。
    const ref = await created
    const startedAt = Date.now()
    this.activeRuns.add(ref.id)
    this.telemetry?.activeRuns(this.activeRuns.size)
    this.telemetry?.start({
      ...fields,
      runId: ref.id,
      taskId: ref.taskId,
      conversationId: ref.conversationId,
    })
    const result = (async (): Promise<RunOutcome> => {
      try {
        await task
      } catch (error) {
        sink.fail(error)
        throw error
      }
      if (!this.runs) throw engineError('engine_internal', 'RunRepository 未注入')
      const run = await this.runs.findEntity(ref.id)
      if (!run)
        throw engineError('engine_internal', `run ${ref.id} 已创建但读不到终态`, { runId: ref.id })
      const outcome = this.toOutcome(run)
      this.telemetry?.finish({
        runId: ref.id,
        status: outcome.status,
        stopReason: outcome.stopReason,
        durationMs: Date.now() - startedAt,
        usage: outcome.usage,
      })
      return outcome
    })().finally(() => {
      this.activeRuns.delete(ref.id)
      this.telemetry?.activeRuns(this.activeRuns.size)
    })
    // 未消费 result 的调用方（例如只管 SS E 的 controller）不应触发 unhandled rejection
    result.catch(() => undefined)
    return {
      runId: ref.id,
      conversationId: ref.conversationId,
      taskId: ref.taskId,
      events: sink.events,
      result,
      abort: (_reason?: string) => {
        void this.chat.stopRun(caller.id, { runId: ref.id }).catch((error: unknown) => {
          this.logger?.warn('ai.engine.abort_failed', {
            runId: ref.id,
            reason: error instanceof Error ? error.message : String(error),
          })
        })
      },
    }
  }

  /** run 实体 → 引擎结果 */
  private toOutcome(run: RunEntity): RunOutcome {
    if (!isTerminalRunState(run.status) && run.status !== RunStatus.Suspended) {
      // 执行体已返回但 run 仍非终态：说明收尾没走到（例如 task 正常结束、库还是 running）
      this.logger?.warn('engine.run.finish_non_terminal', {
        runId: run.id,
        status: run.status,
      })
    }
    const status = this.outcomeStatus(run.status)
    return {
      runId: run.id,
      conversationId: run.conversationId,
      status,
      stopReason:
        run.status === RunStatus.Suspended
          ? 'suspended'
          : run.status === RunStatus.Canceled
            ? 'canceled'
            : run.status === RunStatus.Interrupted
              ? 'interrupted'
              : status === 'succeeded'
                ? 'done'
                : 'error',
      usage: run.usage,
      ...(run.errorCode || run.errorMessage
        ? {
            error: {
              code: run.errorCode ?? 'engine_internal',
              message: run.errorMessage ?? '运行失败',
            },
          }
        : {}),
    }
  }

  private outcomeStatus(status: string): RunOutcome['status'] {
    if (status === RunStatus.Succeeded) return 'succeeded'
    if (status === RunStatus.Canceled) return 'canceled'
    if (status === RunStatus.Suspended) return 'suspended'
    return 'failed'
  }

  /** 建 run 前的失败也要让 `start()` 拿到错误，而不是永远挂着 */
  private deferredRef(): {
    promise: Promise<RunRef>
    resolve: (ref: RunRef) => void
    reject: (error: unknown) => void
  } {
    let resolve!: (ref: RunRef) => void
    let reject!: (error: unknown) => void
    const promise = new Promise<RunRef>((res, rej) => {
      resolve = res
      reject = rej
    })
    promise.catch(() => undefined)
    return { promise, resolve, reject }
  }
}
