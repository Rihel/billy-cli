import { Agent } from '@mastra/core/agent'
import { toAISdkStream } from '@mastra/ai-sdk'
import { Inject, Injectable } from '@nestjs/common'
import { AppLogger } from '@repo/kits'
import {
  RunErrorStage,
  RunStatus,
  TimelineKind,
  TimelineRole,
} from '@repo/shared'
import { AGENT_MAX_STEPS } from '../core/ai.constants.js'
import {
  AgentConfig,
  toAgentModelId,
  type AgentConfig as AgentConfigValue,
} from '../core/ai.config.js'
import type { AgentRuntimeEnvelope } from '../core/ai.core.types.js'
import { toUsageRecord, usageField } from './usage.js'
import { RunRepository } from './run.repository.js'
import { StreamRecorder } from './stream-recorder.js'
import { TimelineRepository } from './timeline.repository.js'

/** 子 agent 的最终结论（**这个对象会作为 `run-sub-agent` 的工具出参交给主 agent**，故字段要自解释） */
export interface SubAgentOutcome {
  /** 子 agent 的 run id（`null` = 没跑起来，见 `reason`） */
  subRunId: string | null
  name: string
  /** `succeeded` 跑完 / `failed` 失败 / `canceled` 被停止 / `rejected` 根本没跑（配额 / 深度） */
  status: 'succeeded' | 'failed' | 'canceled' | 'rejected'
  /** 子 agent 的最终文本（失败时为空串，原因在 `error`） */
  result: string
  error: string | null
  stepCount: number
  toolCallCount: number
  usage: Record<string, unknown> | null
  durationMs: number
  /** 是否命中幂等复用（崩溃恢复重放，**没有重跑、没有重复扣费**） */
  reused?: boolean
  /** `rejected` 的原因（配额 / 深度），给模型看的话术 */
  reason?: string
}

/** 发起一个子 agent 的入参（工具层解析完后交过来） */
export interface SubAgentRequest {
  /** 子助手短标识（主 agent 起的名字） */
  name: string
  /** **主 agent 现场撰写的系统提示词**（原样使用，我们不追加也不覆盖） */
  systemPrompt: string
  /** 交给子 agent 的任务（作为它的第一条用户消息） */
  task: string
  /** 父那次工具调用的 id（幂等键；拿不到时为 null） */
  toolCallId: string | null
  /** 运行时信封（会话 / 父 run / 深度 / 子工具面） */
  envelope: AgentRuntimeEnvelope
  /** 把实时明细写进父流（非流式调用时为 undefined） */
  writer?: SubAgentWriter
}

/** Mastra 的工具输出流（`ToolStream` 的最小面；只用到 `write`） */
export interface SubAgentWriter {
  write: (chunk: unknown) => Promise<unknown> | unknown
}

/** UI Message Stream 片段的最小结构（只取我们关心的字段） */
interface ChunkLike {
  type?: string
  id?: string
  delta?: string
  toolCallId?: string
  toolName?: string
  input?: unknown
  output?: unknown
  errorText?: string
}

/**
 * 配置缺失时的兜底值。
 *
 * 别把 `undefined` 交给 `setTimeout` —— 那等于**立即超时**（子 agent 刚起就被判超时），
 * 是本模块最隐蔽的失败形态（配置写成 `as never` 的测试栈最容易踩）。
 */
const DEFAULT_RUN_TIMEOUT_MS = 10 * 60_000
const DEFAULT_MAX_PER_RUN = 4
const DEFAULT_MAX_DEPTH = 1

/** 子 agent 名称 → 入库用的 agent key（`sub:<slug>`，列宽 64） */
const toSubAgentKey = (name: string): string =>
  `sub:${name.trim().replace(/\s+/g, '-').slice(0, 48)}`

/**
 * **子 agent 执行器**：动态创建并跑一个子 agent，把它的一切落库。
 *
 * 分工（`docs/design/ai-agent.md` §3.14）：
 * - 子 agent 是**独立 run**（`parent_run_id` / `depth` / `tool_call_id`），与父同会话；
 * - 它的消息、推理、工具调用与结果、每步用量走**与主 run 同一个录制器**（细节不缩水）；
 * - 主 agent 现场写的 `system_prompt` 与 `task` **全量落 `runs.request_snapshot`**
 *   ——"子 agent 为什么这么干"的唯一证据；
 * - 实时明细经工具上下文的 `writer` 写成 `data-sub-agent*` 块，进的是**父的那一条流**；
 * - 幂等：同一 `(parent_run_id, tool_call_id)` 已成功过 → 直接复用结论（不重跑、不重复扣费）。
 *
 * 它是普通 bean（**不是** core bean）：core bean 负责"把能力交出去"，本类负责"怎么跑"。
 */
@Injectable()
export class AgentRunner {
  constructor(
    @Inject(RunRepository) private readonly runs: RunRepository,
    @Inject(TimelineRepository) private readonly timelines: TimelineRepository,
    @Inject(AgentConfig) private readonly config: AgentConfigValue,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}

  /** 跑一个子 agent（工具 `run-sub-agent` 的唯一入口；**不抛业务异常**，失败作为工具结论返回） */
  async runSubAgent(request: SubAgentRequest): Promise<SubAgentOutcome> {
    const { envelope } = request
    const startedAt = Date.now()

    // ① 深度守卫（当前工具面已保证为 1：子 agent 拿不到委派类工具，这里是第二道闸）
    if (envelope.depth + 1 > (this.config.subAgentMaxDepth || DEFAULT_MAX_DEPTH)) {
      return this.rejected(request, startedAt, '子助手不能再创建子助手（已达深度上限）')
    }

    // ② 幂等：重放（崩溃恢复）时同一个 toolCallId 只会真正跑一次
    if (request.toolCallId) {
      const existing = await this.runs.findChildByToolCall(
        envelope.parentRunId,
        request.toolCallId,
      )
      if (existing && existing.status === RunStatus.Succeeded) {
        const text = (await this.timelines.lastTextOfRun(existing.id)) ?? ''
        this.logger.log('ai.subagent.reused', {
          parentRunId: envelope.parentRunId,
          subRunId: existing.id,
          toolCallId: request.toolCallId,
        })
        await this.writeState(request, existing.id, { status: existing.status, result: text })
        return {
          subRunId: existing.id,
          name: request.name,
          status: 'succeeded',
          result: text,
          error: null,
          stepCount: existing.stepCount,
          toolCallCount: existing.toolCallCount,
          usage: existing.usage,
          durationMs: existing.durationMs ?? 0,
          reused: true,
        }
      }
    }

    // ③ 配额守卫：**不抛异常炸整轮**，把"配额已满"作为结论交回给模型，让它自己收场
    const existingChildren = await this.runs.countChildren(envelope.parentRunId)
    const maxPerRun = this.config.subAgentMaxPerRun || DEFAULT_MAX_PER_RUN
    if (existingChildren >= maxPerRun) {
      return this.rejected(
        request,
        startedAt,
        `本次已创建 ${existingChildren} 个子助手，达到上限（${maxPerRun}），请自己完成剩余工作`,
      )
    }

    // ④ 建子 run（与父同会话；**不参与**"同一会话只允许一轮进行中"的唯一索引，见迁移）
    const agentKey = toSubAgentKey(request.name)
    const child = await this.runs.create({
      conversationId: envelope.conversationId,
      agentKey,
      status: RunStatus.Pending,
      triggeredBy: envelope.triggeredBy,
      parentRunId: envelope.parentRunId,
      depth: envelope.depth + 1,
      toolCallId: request.toolCallId,
    })
    await this.runs.markRunning(child.id)
    // 动态提示词与任务**全量落库**（不裁剪）：这是子 agent 行为的唯一证据链
    await this.runs.saveRequestSnapshot(child.id, {
      kind: 'subagent',
      name: request.name,
      systemPrompt: request.systemPrompt,
      task: request.task,
      parentRunId: envelope.parentRunId,
      depth: envelope.depth + 1,
      toolKey: 'run-sub-agent',
    })
    const now = new Date()
    await this.timelines.append({
      conversationId: envelope.conversationId,
      runId: child.id,
      role: TimelineRole.User,
      kind: TimelineKind.Text,
      payload: { text: request.task },
      startedAt: now,
      finishedAt: now,
    })
    await this.writeState(request, child.id, { status: RunStatus.Running, task: request.task })

    const recorder = new StreamRecorder(this.timelines, {
      conversationId: envelope.conversationId,
      runId: child.id,
    })
    // 子 agent 的墙钟上限（0 = 沿用单轮上限）；心跳照跳，看门狗不会误杀长跑的子 agent
    const timeoutMs =
      this.config.subAgentTimeoutMs || this.config.runTimeoutMs || DEFAULT_RUN_TIMEOUT_MS
    const timeoutController = new AbortController()
    const timeoutTimer = setTimeout(() => timeoutController.abort(), timeoutMs)
    const signals = [timeoutController.signal]
    if (envelope.abortSignal) signals.push(envelope.abortSignal)
    const abortSignal = AbortSignal.any(signals)
    const heartbeat = setInterval(() => {
      void this.runs.touchHeartbeat(child.id).catch(() => undefined)
    }, 1_000)

    let text = ''
    try {
      // 子 agent **继承父这一轮的模型**（信封里带着）：不单独选模型，也就不会出现"父子用了两个模型"
      const model = envelope.model
      const agent = new Agent({
        // 临时实例：跑完即弃，**不注册进 Mastra**（否则会污染 agent 清单、且同名会冲突）
        id: `${agentKey}#${child.id}`,
        name: request.name,
        // **完全用主 agent 写的提示词**：我们不加 partial、不改一个字
        instructions: request.systemPrompt,
        model: {
          // modelRef 是 `<providerSlug>/<modelKey>`，正是 Mastra 认识的 `provider/model` 形态
          id: toAgentModelId(model.modelRef),
          url: model.baseURL,
          apiKey: model.apiKey,
        },
        tools: envelope.childTools,
        skills: [...envelope.childSkills],
      })

      const output = await agent.stream([{ role: 'user', content: request.task }] as never, {
        maxSteps: this.config.subAgentMaxSteps || AGENT_MAX_STEPS,
        abortSignal,
      })
      const uiStream = toAISdkStream(output, {
        from: 'agent',
        version: 'v6',
        sendReasoning: true,
        sendSources: true,
      })

      const reader = (uiStream as unknown as ReadableStream<ChunkLike>).getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        const chunk = value
        await recorder.consume(chunk)
        const delta = this.toDelta(chunk)
        if (delta) {
          text += delta.text
          await this.writeDelta(request, child.id, delta.kind, delta.text)
        }
        const event = this.toEvent(chunk)
        if (event) await this.writeState(request, child.id, { event })
      }

      // 被中止（用户停止 / 超时）：Mastra 会正常返回，必须自己判定这不是成功
      if (abortSignal.aborted) {
        await recorder.flushPending()
        const canceled = envelope.abortSignal?.aborted ?? false
        return await this.finish(
          request,
          child.id,
          canceled ? RunStatus.Canceled : RunStatus.Failed,
          text,
          startedAt,
          recorder,
          output,
          canceled ? null : '子助手超时（服务端判定）',
        )
      }

      await recorder.flushPending()
      return await this.finish(
        request,
        child.id,
        RunStatus.Succeeded,
        text,
        startedAt,
        recorder,
        output,
        null,
      )
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      this.logger.error('ai.subagent.failed', {
        parentRunId: envelope.parentRunId,
        subRunId: child.id,
        reason,
      })
      return await this.finish(
        request,
        child.id,
        envelope.abortSignal?.aborted ? RunStatus.Canceled : RunStatus.Failed,
        text,
        startedAt,
        recorder,
        null,
        reason,
      )
    } finally {
      clearInterval(heartbeat)
      clearTimeout(timeoutTimer)
    }
  }

  /** 收尾：终态 + 消耗 + 统计 + 实时状态，并把结论交给主 agent */
  private async finish(
    request: SubAgentRequest,
    subRunId: string,
    status: string,
    text: string,
    startedAt: number,
    recorder: StreamRecorder,
    output: unknown,
    error: string | null,
  ): Promise<SubAgentOutcome> {
    // 步级用量只有读完流才知道；`output` 为 null（抛错路径）时只用录制器已知的部分
    const steps = output
      ? ((await (output as { steps: Promise<unknown> }).steps) as unknown[] as never[])
      : []
    const usage = output
      ? toUsageRecord(
          (await (output as { totalUsage: Promise<unknown> }).totalUsage) as Record<
            string,
            unknown
          >,
        )
      : null
    const persisted = await recorder.finish(steps)
    const durationMs = Date.now() - startedAt
    await this.runs.finish(subRunId, {
      status,
      usage,
      stepCount: steps.length,
      toolCallCount: persisted.toolCallCount,
      durationMs,
      ...(error
        ? {
            errorCode: null,
            errorStage: RunErrorStage.Subagent,
            errorMessage: error,
            errorDetail: { raw: error },
          }
        : {}),
    })
    if (error) {
      await this.timelines.append({
        conversationId: request.envelope.conversationId,
        runId: subRunId,
        role: TimelineRole.System,
        kind: TimelineKind.Error,
        payload: { message: error, stage: RunErrorStage.Subagent },
        finishedAt: new Date(),
      })
    }
    const outcome: SubAgentOutcome = {
      subRunId,
      name: request.name,
      status:
        status === RunStatus.Succeeded
          ? 'succeeded'
          : status === RunStatus.Canceled
            ? 'canceled'
            : 'failed',
      result: text,
      error,
      stepCount: steps.length,
      toolCallCount: persisted.toolCallCount,
      usage,
      durationMs,
    }
    await this.writeState(request, subRunId, {
      status: outcome.status,
      stepCount: outcome.stepCount,
      toolCallCount: outcome.toolCallCount,
      usage,
      durationMs,
      result: text,
      error,
    })
    this.logger.log('ai.subagent.finished', {
      parentRunId: request.envelope.parentRunId,
      subRunId,
      name: request.name,
      status: outcome.status,
      durationMs,
      tokenTotal: usage ? usageField(usage, 'totalTokens') : null,
    })
    return outcome
  }

  /** 没跑起来（配额 / 深度）：记一条状态事件，把原因作为工具结论交回模型 */
  private async rejected(
    request: SubAgentRequest,
    startedAt: number,
    reason: string,
  ): Promise<SubAgentOutcome> {
    this.logger.warn('ai.subagent.rejected', {
      parentRunId: request.envelope.parentRunId,
      name: request.name,
      reason,
    })
    await this.timelines.append({
      conversationId: request.envelope.conversationId,
      runId: request.envelope.parentRunId,
      role: TimelineRole.System,
      kind: TimelineKind.Status,
      payload: { status: 'subagent_rejected', name: request.name, reason },
      finishedAt: new Date(),
    })
    return {
      subRunId: null,
      name: request.name,
      status: 'rejected',
      result: '',
      error: null,
      stepCount: 0,
      toolCallCount: 0,
      usage: null,
      durationMs: Date.now() - startedAt,
      reason,
    }
  }

  /** 片段 → 增量（文本 / 推理）；其余类型返回 null */
  private toDelta(chunk: ChunkLike): { kind: 'text' | 'reasoning'; text: string } | null {
    if (chunk.type === 'text-delta' && chunk.delta) return { kind: 'text', text: chunk.delta }
    if (chunk.type === 'reasoning-delta' && chunk.delta) {
      return { kind: 'reasoning', text: chunk.delta }
    }
    return null
  }

  /** 片段 → 结构化事件（工具调用与结果；这些是嵌套面板要展示的"细节"） */
  private toEvent(chunk: ChunkLike): Record<string, unknown> | null {
    switch (chunk.type) {
      case 'tool-input-available':
        return {
          kind: 'tool-call',
          toolCallId: chunk.toolCallId ?? null,
          toolKey: chunk.toolName ?? null,
          // 入参**完整**下发（与落库口径一致，不裁剪）
          input: chunk.input ?? null,
        }
      case 'tool-output-available':
        return {
          kind: 'tool-result',
          toolCallId: chunk.toolCallId ?? null,
          toolKey: chunk.toolName ?? null,
          output: chunk.output ?? null,
          isError: false,
        }
      case 'tool-output-error':
        return {
          kind: 'tool-result',
          toolCallId: chunk.toolCallId ?? null,
          toolKey: chunk.toolName ?? null,
          errorText: chunk.errorText ?? null,
          isError: true,
        }
      default:
        return null
    }
  }

  /**
   * 写"增量"块：**不带 id**。
   *
   * AI SDK v6 的 data part 是**按 id 归并**的（同 id 后者覆盖前者），所以增量必须一块一个；
   * 状态类信息才用 id 归并成"当前快照"（见 {@link writeState}）。
   */
  private async writeDelta(
    request: SubAgentRequest,
    subRunId: string,
    kind: 'text' | 'reasoning',
    text: string,
  ): Promise<void> {
    if (!request.writer) return
    await request.writer.write({
      type: 'data-sub-agent-delta',
      data: { runId: subRunId, name: request.name, kind, text },
    })
  }

  /** 写"状态"块：带 `id = subRunId`，前端按 id 归并出这个子 agent 的当前快照 */
  private async writeState(
    request: SubAgentRequest,
    subRunId: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    if (!request.writer) return
    await request.writer.write({
      type: 'data-sub-agent',
      id: subRunId,
      data: { runId: subRunId, name: request.name, ...data },
    })
  }
}
