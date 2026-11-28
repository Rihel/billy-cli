import type { AppLogger } from '@repo/kits'
import type { StreamPublisher } from '../../engine/ports.js'
import type { StreamResponseLike } from '../stream/stream-response.js'
import { AppErrorCodes, RunErrorStage, RunStatus, TimelineKind, TimelineRole } from '@repo/shared'
import type { RunRepository } from '../run/run.repository.js'
import type { ConversationRepository } from '../conversation/conversation.repository.js'
import type { TimelineRepository } from '../run/timeline.repository.js'
import { rollUpUsage } from '../run/usage-roller.js'
import { totalTokensOf } from '../run/usage.js'

/** 成功收尾的依赖 */
export interface SucceedTurnDeps {
  runs: RunRepository
  conversations: ConversationRepository
  logger: AppLogger
  /** 把 `data-run-usage` 发出去（流式路径带 response，无头路径只进记录 + 广播） */
  emitUsage: (chunk: unknown) => Promise<unknown>
  /** 续跑路径成功后要清 Redis 进度键（首轮 / 队列在 finally 统一清） */
  streams?: StreamPublisher
}

export interface SucceedTurnInput {
  runId: string
  conversationId: string
  usage: Record<string, unknown> | null
  stepCount: number
  toolCallCount: number
  durationMs: number
  firstTokenMs: number | null
  /** 成功日志事件名（首轮 / 队列各一个，便于按路径检索） */
  logEvent: string
  /** 是否清 Redis 进度键（续跑路径用；首轮 / 队列由 finally 清） */
  clearRun?: boolean
  /** 非流式路径没有活动流，跳过活动流释放 */
  skipActiveStream?: boolean
  /** 非流式路径不发 `data-run-usage` */
  skipUsageEvent?: boolean
  /** 日志附加字段（例如队列路径的 origin） */
  logFields?: Record<string, unknown>
}

/**
 * 成功收尾：终态落库 → 释放活动流 → 会话累计 → 下发本轮用量。
 *
 * 顺序不能换：`data-run-usage` 必须在终态落库**之后**发（客户端看到用量时，
 * 库里也一定有了）；`setActiveStream(null)` 必须在累计之前，避免看门狗看到"还在跑"。
 *
 * 为什么走流而不是让前端再查一次：用量只有收尾时才知道，而"收尾已落库"与
 * `RUN_FINISHED` 之间是唯一能保证"客户端看到用量时，库里也一定有了"的位置；
 * 同时进 Redis 记录与广播，断线重连补发也拿得到。
 */
export const finishSucceededTurn = async (
  deps: SucceedTurnDeps,
  input: SucceedTurnInput,
): Promise<void> => {
  await deps.runs.finish(input.runId, {
    status: RunStatus.Succeeded,
    usage: input.usage,
    stepCount: input.stepCount,
    toolCallCount: input.toolCallCount,
    durationMs: input.durationMs,
    firstTokenMs: input.firstTokenMs,
  })
  if (!input.skipActiveStream) await deps.runs.setActiveStream(input.runId, null)
  if (input.clearRun) await deps.streams?.clearRun(input.runId)
  await deps.conversations.accumulate(input.conversationId, totalTokensOf(input.usage))

  deps.logger.log(input.logEvent, {
    conversationId: input.conversationId,
    runId: input.runId,
    stepCount: input.stepCount,
    toolCallCount: input.toolCallCount,
    durationMs: input.durationMs,
    ...input.logFields,
  })

  if (!input.skipUsageEvent) {
    await deps.emitUsage({
      type: 'data-run-usage',
      data: {
        runId: input.runId,
        usage: input.usage,
        stepCount: input.stepCount,
        toolCallCount: input.toolCallCount,
        durationMs: input.durationMs,
      },
    })
  }
}

/** 失败 / 取消收尾的分类 */
export type TurnFailureKind = 'timeout' | 'canceled' | 'failed'

/** 失败收尾的依赖 */
export interface FailTurnDeps {
  runs: RunRepository
  timelines: TimelineRepository
  logger: AppLogger
  /** 级联取消子 run 与待唤醒项（幂等） */
  cascadeStop: (runId: string, conversationId: string) => Promise<void>
  /** 失败的一轮也留个会话名（首轮 / 用户消息才需要） */
  writeFallbackTitle?: () => Promise<void>
}

export interface FailTurnInput {
  kind: TurnFailureKind
  runId: string
  conversationId: string
  durationMs: number
  /** 原始错误文本（落日志与 errorDetail） */
  reason: string
  /** timeout 的配置值 */
  timeoutMs?: number
  /** canceled 的操作人 */
  operator?: string
  /** 队列 / 唤醒路径的来源（写进时间线 payload） */
  origin?: 'user' | 'subagent'
  /** 已映射的错误（timeout / failed 时有，用于写错误码与 message） */
  mapped?: Error | null
  logEvent: string
  logFields?: Record<string, unknown>
  /** 是否补兜底会话名 */
  writeTitle: boolean
  /** 是否释放活动流（首轮 catch 需要；无头队列由 finally 统一清理） */
  clearActiveStream: boolean
}

/**
 * 失败 / 取消收尾：终态 + 审计事件 + 级联取消（+ 兜底标题）。
 *
 * 三条语义：
 * - `timeout`：首 token 超时（3314），是**失败**不是取消；
 * - `canceled`：用户主动停止，写 `operator`，不再补标题；
 * - `failed`：上游 / 执行失败，尽量把子 agent 已烧的 token 记在账上。
 *
 * 返回 `canceled` 还是 `failed`，供无头队列把结果返回给调度器。
 */
export const finishFailedTurn = async (
  deps: FailTurnDeps,
  input: FailTurnInput,
): Promise<'failed' | 'canceled'> => {
  if (input.kind === 'canceled') {
    await deps.runs.finish(input.runId, {
      status: RunStatus.Canceled,
      durationMs: input.durationMs,
    })
    await deps.timelines.append({
      conversationId: input.conversationId,
      runId: input.runId,
      role: TimelineRole.System,
      kind: TimelineKind.Status,
      payload: {
        status: RunStatus.Canceled,
        reason: 'user_stopped',
        ...(input.operator ? { operator: input.operator } : {}),
        ...(input.origin ? { origin: input.origin } : {}),
      },
      finishedAt: new Date(),
    })
    await deps.cascadeStop(input.runId, input.conversationId)
    if (input.clearActiveStream) await deps.runs.setActiveStream(input.runId, null)
    deps.logger.log(input.logEvent, {
      runId: input.runId,
      durationMs: input.durationMs,
      ...input.logFields,
    })
    return 'canceled'
  }

  const timeout = input.kind === 'timeout'
  const message = input.mapped?.message ?? input.reason
  await deps.runs.finish(input.runId, {
    status: RunStatus.Failed,
    // 失败也要把子 agent 已经烧掉的 token 记在账上
    usage: await rollUpUsage(deps.runs, input.runId, null),
    errorCode: String(
      timeout
        ? AppErrorCodes.ModelNoResponse
        : ((input.mapped as { code?: number } | null)?.code ?? AppErrorCodes.AgentFailed),
    ),
    errorStage: RunErrorStage.Model,
    errorMessage: message,
    errorDetail: timeout
      ? { raw: input.reason, timeoutMs: input.timeoutMs }
      : { raw: input.reason },
    durationMs: input.durationMs,
  })
  await deps.timelines.append({
    conversationId: input.conversationId,
    runId: input.runId,
    role: TimelineRole.System,
    kind: TimelineKind.Error,
    payload: {
      message,
      stage: RunErrorStage.Model,
      ...(timeout ? { reason: 'first_token_timeout' } : {}),
      ...(input.origin ? { origin: input.origin } : {}),
    },
    finishedAt: new Date(),
  })
  await deps.cascadeStop(input.runId, input.conversationId)
  if (input.writeTitle && deps.writeFallbackTitle) await deps.writeFallbackTitle()
  if (input.clearActiveStream) await deps.runs.setActiveStream(input.runId, null)
  deps.logger.error(input.logEvent, {
    runId: input.runId,
    reason: input.reason,
    durationMs: input.durationMs,
    ...input.logFields,
  })
  return 'failed'
}

/** 挂起收尾的依赖 */
export interface SuspendTurnDeps {
  runs: RunRepository
  streams?: StreamPublisher
  logger: AppLogger
  agui: {
    emit: (input: {
      runId: string
      threadId: string
      chunk: unknown
      response?: StreamResponseLike
      messageIdRef?: { value: string }
    }) => Promise<number>
    finish: (response: StreamResponseLike, runId: string, threadId: string) => Promise<void>
  }
  approvalPort?: {
    suspend: (input: {
      runId: string
      conversationId: string
      questions: readonly unknown[]
    }) => Promise<void>
  } | null
  telemetry?: { suspend: (fields: { runId: string }) => void } | null
}

export interface SuspendTurnInput {
  runId: string
  conversationId: string
  usage: Record<string, unknown> | null
  stepCount: number
  toolCallCount: number
  durationMs: number
  response?: StreamResponseLike
  messageIdRef?: { value: string }
  /** 是否写 `RUN_FINISHED` 并关响应（首轮 true；无头队列 false） */
  finishStream: boolean
  /** 是否发 `data-run-suspended`（续跑再次挂起时前端已从工具挂起块知道，不再重复发） */
  emitEvent?: boolean
  /** 是否清 Redis 进度键（续跑路径用） */
  clearRun?: boolean
  logEvent: string
  logFields?: Record<string, unknown>
}

/**
 * 挂起收尾：这一轮**没有结束**，只是停在等用户回答。
 *
 * 不能走成功收尾；否则会话被释放、快照被当成"已完成"，用户回答时没有可续跑的 run。
 * 这里把状态落成 `suspended`，保住 `engine_run_id` 与 Mastra 快照，回答时走
 * `/agent/chat/resume` 从同一条 run 继续。
 */
export const finishSuspendedTurn = async (
  deps: SuspendTurnDeps,
  input: SuspendTurnInput,
): Promise<void> => {
  await deps.runs.suspend(input.runId, {
    usage: input.usage,
    stepCount: input.stepCount,
    toolCallCount: input.toolCallCount,
    durationMs: input.durationMs,
  })
  // 审批接缝：挂起事实进审计（危险命令人工批准将来走同一个口）
  await deps.approvalPort?.suspend({
    runId: input.runId,
    conversationId: input.conversationId,
    questions: [],
  })
  deps.telemetry?.suspend({ runId: input.runId })
  await deps.runs.setActiveStream(input.runId, null)
  if (input.clearRun) await deps.streams?.clearRun(input.runId)
  if (input.emitEvent !== false) {
    await deps.agui.emit({
      runId: input.runId,
      threadId: input.conversationId,
      chunk: {
        type: 'data-run-suspended',
        data: { runId: input.runId, conversationId: input.conversationId },
      },
      ...(input.response ? { response: input.response } : {}),
      ...(input.messageIdRef ? { messageIdRef: input.messageIdRef } : {}),
    })
  }
  if (input.finishStream && input.response) {
    await deps.agui.finish(input.response, input.runId, input.conversationId)
  }
  deps.logger.log(input.logEvent, {
    conversationId: input.conversationId,
    runId: input.runId,
    stepCount: input.stepCount,
    toolCallCount: input.toolCallCount,
    ...input.logFields,
  })
}
