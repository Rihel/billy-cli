import { Inject, Injectable } from '@nestjs/common'
import { ModuleRef } from '@nestjs/core'
import dedent from 'dedent'
import { AppLogger } from '@repo/kits'
import {
  RunErrorStage,
  RunStatus,
  TimelineKind,
  TimelineRole,
} from '@repo/shared'
import { AGENT_MAX_STEPS } from '../core/ai.constants.js'
import { createMastraAgent, toMastraModel } from '../mastra/agent.adapter.js'
import { toMastraSkills } from '../mastra/skill.adapter.js'
import { toUiStream } from '../mastra/stream.adapter.js'
import { toRequestContext } from '../mastra/context.adapter.js'
import { toMastraTools } from '../mastra/tool.adapter.js'
import { ToolRegistry } from '../tools/tool.registry.js'
import { ToolCallMetaStore } from '../tools/tool.meta.js'
import { AgentConfig, type AgentConfig as AgentConfigValue } from '../core/ai.config.js'
import type { AgentRuntimeEnvelope } from '../core/ai.core.types.js'
import { toUsageRecord, usageField } from './usage.js'
import { RunRepository } from './run.repository.js'
import { StreamRecorder } from './stream-recorder.js'
import { readStreamSteps, readStreamUsage } from './stream-result.js'
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

/** 子 agent 的四个旋钮（来自 `run-sub-agent` 的工具配置；0 = 沿用部署默认） */
export interface SubAgentQuotas {
  maxPerRun?: number
  maxDepth?: number
  maxSteps?: number
  timeoutMs?: number
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
  /** 四个旋钮（来自工具配置；缺省走部署默认） */
  quotas?: SubAgentQuotas
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

/**
 * 给子 agent 的提示词**追加一段固定的能力段**（设计 §5.10 第 4 条，待拍板项按"追加"实现）。
 *
 * 为什么追加：主 agent 写的那份是"任务指令"，但子 agent 的上下文里**没有我们的《工具》模板段**
 * （它的提示词由主 agent 现写），于是它不知道自己手上有什么、也不知道"不能再造子助手"这条边界。
 * 这段尾巴不覆盖主 agent 的原话，只补三件事：工具清单、边界、交付要求。
 */
const withCapabilityTail = (
  writtenByParent: string,
  envelope: AgentRuntimeEnvelope,
): string => {
  const tools = [...envelope.childToolbox.keys()]
  const toolList = tools.length > 0 ? tools.map((key) => `\`${key}\``).join('、') : '（无）'
  return dedent`
    ${writtenByParent.trim()}

    # 你的能力与边界（系统补充，不要与上面的要求冲突）
    - 你可以调用的工具：${toolList}；
    - 你**不能**创建子助手，也不要假装有清单外的工具；需要别的能力就把结论交回主 agent；
    - 你看到的上下文只有上面的任务说明，主 agent 与用户的对话你**看不到**；
    - 交付要求：给出结论 + 关键依据（口径、命令、文件路径），不要转贴大段原始输出。
  `
}

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
 * 它是普通 bean（**不是**工具类）：工具类负责"把能力交出去"，本类负责"怎么跑"。
 */
@Injectable()
export class AgentRunner {
  constructor(
    @Inject(RunRepository) private readonly runs: RunRepository,
    @Inject(TimelineRepository) private readonly timelines: TimelineRepository,
    @Inject(AgentConfig) private readonly config: AgentConfigValue,
    @Inject(AppLogger) private readonly logger: AppLogger,
    @Inject(ToolCallMetaStore) private readonly toolMetas: ToolCallMetaStore,
    /**
     * ⚠️ 注册机**只能惰性取**（`ModuleRef`），不能进构造器。
     *
     * 原因：`ToolRegistry → AGENT_TOOLS → RunSubAgentTool → AgentRunner`，若这里再注入注册机就成了环；
     * 而 Nest 对**工厂型 provider** 的环**不报错、直接静默死锁**（实测：进程 CPU 0%，永远停在启动中）。
     * 这里只在真正要写时间线时取一次，那时容器早就绪了。
     */
    @Inject(ModuleRef) private readonly moduleRef: ModuleRef,
  ) {}

  /** 惰性取注册机（用于把"模型编出来的工具名"标成 `unknown-tool`）；取不到就退化为"不判定" */
  private knownToolPredicate(): ((toolKey: string) => boolean) | undefined {
    try {
      const registry = this.moduleRef.get(ToolRegistry, { strict: false })
      return (toolKey: string) => Boolean(registry.get(toolKey))
    } catch {
      return undefined
    }
  }

  /** 跑一个子 agent（工具 `run-sub-agent` 的唯一入口；**不抛业务异常**，失败作为工具结论返回） */
  async runSubAgent(request: SubAgentRequest): Promise<SubAgentOutcome> {
    const { envelope } = request
    const startedAt = Date.now()

    // ① 深度守卫（当前工具面已保证为 1：子 agent 拿不到委派类工具，这里是第二道闸）
    const quotas = request.quotas ?? {}
    const maxDepth = quotas.maxDepth || this.config.subAgentMaxDepth || DEFAULT_MAX_DEPTH
    if (envelope.depth + 1 > maxDepth) {
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
    const maxPerRun = quotas.maxPerRun || this.config.subAgentMaxPerRun || DEFAULT_MAX_PER_RUN
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

    const recorder = new StreamRecorder(
      this.timelines,
      { conversationId: envelope.conversationId, runId: child.id },
      {
        metas: this.toolMetas,
        ...(this.knownToolPredicate()
          ? { isKnownTool: this.knownToolPredicate() as (toolKey: string) => boolean }
          : {}),
      },
    )
    // 子 agent 的墙钟上限（0 = 沿用单轮上限）；心跳照跳，看门狗不会误杀长跑的子 agent
    const timeoutMs =
      quotas.timeoutMs || this.config.subAgentTimeoutMs || this.config.runTimeoutMs || DEFAULT_RUN_TIMEOUT_MS
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
      /**
       * 子 agent 的信封：**继承父的**，只改这几项。
       *
       * 为什么必须传下去（设计 §5.10）：网关要判身份 / 作用域 / 限流，审计要写会话与发起人；
       * 早先子 agent 那轮没有信封，规划工具（`plan-*`）每次调用都白烧一步。
       */
      const childEnvelope: AgentRuntimeEnvelope = {
        ...envelope,
        depth: envelope.depth + 1,
        agentKey,
        // 作用域仍按**根** agent 判（子 agent 沿用父的判定）
        rootAgentKey: envelope.rootAgentKey,
        // 子 agent 的工具面 / 技能面：与父同一个口径（编排层在装配信封时算好）
        childToolbox: envelope.childToolbox,
      }
      const agent = createMastraAgent({
        // 临时实例：跑完即弃，**不注册进 Mastra**（否则会污染 agent 清单、且同名会冲突）
        id: `${agentKey}#${child.id}`,
        name: request.name,
        // **完全用主 agent 写的提示词** + 我们追加的一段能力尾巴（工具清单 / 边界 / 交付要求）
        instructions: withCapabilityTail(request.systemPrompt, childEnvelope),
        model: () => toMastraModel(model),
        tools: toMastraTools(envelope.childToolbox, this.logger),
        skills: toMastraSkills(envelope.skills),
      })

      const output = await agent.stream([{ role: 'user', content: request.task }] as never, {
        maxSteps: quotas.maxSteps || this.config.subAgentMaxSteps || AGENT_MAX_STEPS,
        abortSignal,
        // 信封传下去：子 agent 那一轮的工具调用因此也能过网关的权限与审计
        requestContext: toRequestContext(childEnvelope),
      })
      const uiStream = toUiStream(output)

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
    // 步级用量只有读完流才知道；`output` 为 null（抛错路径）时只用录制器已知的部分。
    // **必须走 stream-result 的读取口径**：durable 下 `agent.stream()` 返回的是包装对象
    // （`{ output, fullStream, … }`），直接读 `output.steps` 拿到 undefined（踩过，见 stream-result.ts）
    const steps = output ? ((await readStreamSteps(output)) as unknown as never[]) : []
    const usage = output
      ? toUsageRecord(await readStreamUsage(output))
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
