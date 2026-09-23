import { Inject, Injectable } from '@nestjs/common'
import { AppLogger } from '@repo/kits'
import {
  AppErrorCodes,
  RunErrorStage,
  RunStatus,
  TimelineKind,
  TimelineRole,
  type AgentChatDto,
  type AgentChatResultModel,
  type AgentRunStopResultModel,
} from '@repo/shared'
import { toAISdkStream } from '@mastra/ai-sdk'
import type { Mastra } from '@mastra/core/mastra'
import { RequestContext } from '@mastra/core/request-context'
import { AGENT_MAX_STEPS } from '../core/ai.constants.js'
import {
  AgentConfig,
  type AgentConfig as AgentConfigValue,
} from '../core/ai.config.js'
import {
  AgentFailedError,
  AgentUnavailableError,
  ConversationBusyError,
  ProviderAuthFailedError,
  ProviderRateLimitedError,
  RunNotFoundError,
} from '../core/ai.errors.js'
import { AGENT_REGISTRY } from '../core/ai.registry.js'
import { MASTRA } from '../core/ai.mastra.js'
import {
  AGENT_RUNTIME_KEY,
  type AgentRuntimeEnvelope,
  type RuntimeModel,
} from '../core/ai.core.types.js'
import { AiModelService } from '../../ai-model/index.js'
import type { AgentDefinition, AgentRegistry } from '../core/ai.types.js'
import { SkillLoader } from '../skills/index.js'
import { ToolBuilder } from '../tools/tool.builder.js'
import type { ConversationEntity } from '../../../database/entities/conversation-entity.js'
import type { TimelineEntity } from '../../../database/entities/timeline-entity.js'
import { AgentConversationService } from './conversation.service.js'
import { ContextService } from './context.service.js'
import { ConversationRepository } from './conversation.repository.js'
import { RunRepository } from './run.repository.js'
import { TimelineRepository } from './timeline.repository.js'
import { AgentStreamStore } from './stream-store.service.js'
import { StreamRecorder } from './stream-recorder.js'
import { toPlanPayload } from './plan.js'
import { mergeUsage, toUsageRecord, totalTokensOf } from './usage.js'

/** 并发保护的唯一索引名（同一会话同时只允许一轮进行中） */
const ACTIVE_RUN_CONSTRAINT = 'uk_run_active_conversation'

/** PG 错误的最小结构（TypeORM 会把它放在 driverError 里） */
interface PgError {
  code?: string
  constraint?: string
  detail?: string
}

/** 生成摘要用的指令（只做压缩，不做回答） */
const SUMMARY_INSTRUCTION = `请把上面的对话压缩成一份简明摘要，供后续对话继续使用。
要求：
1. 保留事实（用户是谁、问过什么、结论是什么、涉及的具体数据）；
2. 保留未完成的事项与用户明确的偏好；
3. 不要评价、不要扩写、不要编造；
4. 用简体中文，控制在 500 字以内。`

/** 摘要正文之外，摘要事件还要记住它覆盖了哪一段 */
const SUMMARY_MAX_CHARS = 2_000

/** 用首条用户消息生成会话标题（不额外调模型，省钱） */
const titleFrom = (message: string): string =>
  message.replace(/\s+/g, ' ').trim().slice(0, 40)

/** 上游错误分类：鉴权失败 / 限流 单独成码，其余归通用失败 */
const classifyModelError = (error: unknown): Error => {
  const raw = error instanceof Error ? error.message : String(error)
  const lower = raw.toLowerCase()
  if (
    lower.includes('401') ||
    lower.includes('unauthorized') ||
    lower.includes('invalid api key') ||
    lower.includes('incorrect api key')
  ) {
    return new ProviderAuthFailedError(raw)
  }
  if (lower.includes('429') || lower.includes('rate limit') || lower.includes('too many requests')) {
    return new ProviderRateLimitedError(raw)
  }
  return new AgentFailedError(raw)
}

/**
 * 一轮问答的编排（非流式；流式端点复用同一套落库与收尾逻辑）。
 *
 * 顺序（与设计文档 §3.11.6 的时序图一致）：
 *   建 run → 组装上下文（必要时压缩一次）→ 落用户消息 → 调模型 → 逐事件落时间线
 *   → 收尾（终态 + 消耗 + 会话累计 + 标题）
 *
 * 失败时：写失败原因（错误码 / 环节 / 详情）并落一条 `kind='error'` 时间线事件 —— 失败也要可复盘。
 */
@Injectable()
export class AgentChatService {
  constructor(
    @Inject(MASTRA) private readonly mastra: Mastra | null,
    @Inject(AGENT_REGISTRY) private readonly registry: AgentRegistry,
    @Inject(AgentConfig) private readonly config: AgentConfigValue,
    @Inject(AgentConversationService) private readonly conversations: AgentConversationService,
    @Inject(ConversationRepository) private readonly conversationRepo: ConversationRepository,
    @Inject(RunRepository) private readonly runs: RunRepository,
    @Inject(TimelineRepository) private readonly timelines: TimelineRepository,
    @Inject(ContextService) private readonly context: ContextService,
    @Inject(AgentStreamStore) private readonly streamStore: AgentStreamStore,
    @Inject(ToolBuilder) private readonly toolBuilder: ToolBuilder,
    @Inject(SkillLoader) private readonly skillLoader: SkillLoader,
    @Inject(AiModelService) private readonly models: AiModelService,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}

  /** 本进程内活动运行的中止控制器（跨副本经 Redis 停止频道广播） */
  private readonly activeRuns = new Map<string, AbortController>()

  async chat(userId: string, input: AgentChatDto): Promise<AgentChatResultModel> {
    const mastra = this.requireMastra()
    const conversation = await this.resolveConversation(userId, input)
    const definition = this.registry.resolve(input.agentKey ?? conversation.agentKey)

    const run = await this.startRun(conversation, definition.key, userId)
    const startedAt = Date.now()

    try {
      // ① 解析本轮模型（**只能来自库里的配置**；解析不出来直接 3406/3402，不建流不烧钱）
      const model = await this.resolveRuntimeModel(definition, input.modelId)

      // ② 组装上下文（窗口优先用库里配的实测值；超限则先压缩一次再重新组装，只压一次）
      let built = await this.buildContext(conversation.id, definition, input.message, model)
      if (built.needsCompaction && built.compactionRange) {
        const requestContextForSummary = await this.buildRuntimeContext(
          conversation.id,
          run.id,
          definition,
          userId,
          model,
        )
        await this.summarize(
          conversation.id,
          run.id,
          definition,
          built.compactionRange,
          requestContextForSummary,
        )
        built = await this.buildContext(conversation.id, definition, input.message, model)
      }

      // ② 用户消息先落库（之后无论成败，审计上都能看到"用户问了什么"）
      const now = new Date()
      await this.timelines.append({
        conversationId: conversation.id,
        runId: run.id,
        role: TimelineRole.User,
        kind: TimelineKind.Text,
        payload: { text: input.message },
        startedAt: now,
        finishedAt: now,
      })

      // ④ 调模型（工具往返都在这一步内部完成；运行时信封带"这一轮用哪个模型"）
      const requestContext = await this.buildRuntimeContext(
        conversation.id,
        run.id,
        definition,
        userId,
        model,
      )
      const agent = mastra.getAgent(definition.key)
      const result = await agent.generate(built.messages as never, {
        maxSteps: AGENT_MAX_STEPS,
        requestContext,
      })

      // ④ 逐事件落时间线（保真：文本 / 推理 / 工具入参出参 / 每步用量）
      const steps = (result.steps ?? []) as unknown as StepLike[]
      const persisted = await this.persistSteps(conversation.id, run.id, steps)

      // ⑤ 收尾：终态 + 消耗（含子 agent 汇总）+ 统计 + 会话累计 + 标题
      const usage = await this.rollUpUsage(
        run.id,
        toUsageRecord(result.totalUsage ?? result.usage ?? null),
      )
      const durationMs = Date.now() - startedAt
      await this.runs.finish(run.id, {
        status: RunStatus.Succeeded,
        usage,
        stepCount: steps.length,
        toolCallCount: persisted.toolCallCount,
        durationMs,
      })
      await this.runs.saveRequestSnapshot(run.id, {
        model: model.modelRef,
        agentKey: definition.key,
        toolKeys: [...definition.tools],
        skillKeys: [...definition.skills],
        params: { maxSteps: AGENT_MAX_STEPS },
        context: built.snapshot,
      })
      await this.conversationRepo.accumulate(conversation.id, totalTokensOf(usage))
      if (!conversation.title) {
        await this.conversationRepo.setTitle(conversation.id, titleFrom(input.message))
      }

      this.logger.log('ai.chat.succeeded', {
        conversationId: conversation.id,
        runId: run.id,
        agentKey: definition.key,
        stepCount: steps.length,
        toolCallCount: persisted.toolCallCount,
        durationMs,
      })

      return {
        conversationId: conversation.id,
        runId: run.id,
        status: RunStatus.Succeeded,
        content: (result.text as string) ?? '',
        stepCount: steps.length,
        toolCallCount: persisted.toolCallCount,
        usage,
        durationMs,
      }
    } catch (error) {
      const mapped = classifyModelError(error)
      const durationMs = Date.now() - startedAt
      const message = mapped.message
      await this.runs.finish(run.id, {
        status: RunStatus.Failed,
        // 失败也要把子 agent 已经烧掉的 token 记在账上（否则这笔钱在库里查不到）
        usage: await this.rollUpUsage(run.id, null),
        errorCode: String((mapped as { code?: number }).code ?? AppErrorCodes.AgentFailed),
        errorStage: RunErrorStage.Model,
        errorMessage: message,
        // 上游原文全量保留（脱敏在日志层做；这里不做截断 —— 审计要能查原话）
        errorDetail: { raw: message },
        durationMs,
      })
      await this.timelines.append({
        conversationId: conversation.id,
        runId: run.id,
        role: TimelineRole.System,
        kind: TimelineKind.Error,
        payload: { message, stage: RunErrorStage.Model },
        finishedAt: new Date(),
      })
      this.logger.error('ai.chat.failed', {
        conversationId: conversation.id,
        runId: run.id,
        reason: message,
        durationMs,
      })
      throw mapped
    }
  }

  /** 会话：给了 id 就校验归属；没给就新建 */
  private async resolveConversation(
    userId: string,
    input: AgentChatDto,
  ): Promise<ConversationEntity> {
    if (input.conversationId) {
      return this.conversations.requireOwned(userId, input.conversationId)
    }
    const created = await this.conversations.create(userId, { agentKey: input.agentKey })
    const entity = await this.conversationRepo.findEntity(created.id)
    if (!entity) throw new AgentFailedError('会话创建后立即读取失败')
    return entity
  }

  /**
   * 建立运行记录。
   *
   * 并发保护：同一会话已有进行中的一轮时，`uk_run_active_conversation` 会拒绝插入
   * → 转成 3306（**真相在数据库，不靠应用层"先查再写"**）。
   */
  private async startRun(
    conversation: ConversationEntity,
    agentKey: string,
    userId: string,
  ) {
    try {
      const run = await this.runs.create({
        conversationId: conversation.id,
        agentKey,
        status: RunStatus.Pending,
        triggeredBy: userId,
      })
      await this.runs.markRunning(run.id)
      return run
    } catch (error) {
      // TypeORM 把 PG 的错误信息放在 `driverError` 里（顶层只有 message），两处都取一下
      const driver = (error as { driverError?: PgError }).driverError
      const top = error as PgError
      const code = driver?.code ?? top.code
      const constraint = driver?.constraint ?? top.constraint ?? ''
      const detail = driver?.detail ?? top.detail ?? ''
      if (
        code === '23505' &&
        (constraint === ACTIVE_RUN_CONSTRAINT || detail.includes(ACTIVE_RUN_CONSTRAINT))
      ) {
        throw new ConversationBusyError(conversation.id)
      }
      throw error
    }
  }

  /** 组装上下文（薄封装，便于以后在流式路径复用） */
  private buildContext(
    conversationId: string,
    definition: AgentDefinition,
    userMessage: string,
    model: RuntimeModel,
  ) {
    return this.context.buildInput({
      conversationId,
      // 标识用 `<providerSlug>/<modelKey>`（ContextService 据此查窗口，查不到用兜底值）
      modelId: model.modelRef,
      systemPrompt: definition.instructions,
      userMessage,
      // 库里配过窗口就用它（实测值优先于 tokenlens 的估算）
      ...(model.contextWindow ? { windowTokens: model.contextWindow } : {}),
    })
  }

  /**
   * 解析本轮模型（**唯一的模型来源**，§4.9）。
   *
   * 顺序：本轮显式指定（会话页选择器传 `modelId`）→ agent 声明的默认模型 → 库里第一个启用的。
   * **没有环境变量兜底**：一条都没有时抛 3406，让前端明确提示"先去后台配模型"。
   */
  private async resolveRuntimeModel(
    definition: AgentDefinition,
    modelId?: string,
  ): Promise<RuntimeModel> {
    const resolved = await this.models.resolveForRuntime(modelId ?? definition.model)
    return {
      id: resolved.id,
      modelRef: resolved.modelRef,
      modelKey: resolved.modelKey,
      displayName: resolved.displayName,
      ...(resolved.baseURL ? { baseURL: resolved.baseURL } : {}),
      apiKey: resolved.apiKey,
      contextWindow: resolved.contextWindow,
    }
  }

  /** 把一段旧对话压缩成摘要事件（原文保留，摘要只作"给模型看的新起点"） */
  private async summarize(
    conversationId: string,
    runId: string,
    definition: AgentDefinition,
    range: { fromSeq: number; toSeq: number },
    requestContext: RequestContext,
  ): Promise<void> {
    const mastra = this.requireMastra()
    const events = await this.timelines.listRange(conversationId, range.fromSeq, range.toSeq, {
      rootOnly: true,
    })
    const lines: string[] = []
    for (const event of events) {
      if (event.kind === TimelineKind.Text) {
        const text = typeof event.payload?.text === 'string' ? event.payload.text : ''
        if (text) lines.push(`${event.role === TimelineRole.User ? '用户' : '助手'}：${text}`)
      } else if (event.kind === TimelineKind.ToolCall) {
        lines.push(
          `[工具调用] ${event.toolKey ?? '未知'} 入参：${JSON.stringify(event.payload?.input ?? {})}`,
        )
      } else if (event.kind === TimelineKind.ToolResult) {
        lines.push(
          `[工具结果] ${event.toolKey ?? '未知'} 出参：${JSON.stringify(event.payload?.output ?? null)}`,
        )
      }
    }
    if (lines.length === 0) return

    const startedAt = new Date()
    const agent = mastra.getAgent(definition.key)
    try {
      const result = await agent.generate(
        [
          { role: 'user', content: `以下是需要压缩的历史对话：\n\n${lines.join('\n')}` },
          { role: 'user', content: SUMMARY_INSTRUCTION },
        ] as never,
        // 动态模型要信封（否则模型函数不知道这一轮用哪个模型）
        { maxSteps: 1, requestContext },
      )
      const text = ((result.text as string) ?? '').slice(0, SUMMARY_MAX_CHARS)
      if (!text) return
      await this.timelines.append({
        conversationId,
        runId,
        role: TimelineRole.System,
        kind: TimelineKind.Summary,
        payload: {
          text,
          coversSeqs: [[range.fromSeq, range.toSeq]],
          model: this.config.model ?? null,
          sourceEventCount: events.length,
        },
        usage: toUsageRecord(result.totalUsage ?? result.usage ?? null),
        startedAt,
        finishedAt: new Date(),
        durationMs: Date.now() - startedAt.getTime(),
      })
      this.logger.log('ai.context.compacted', {
        conversationId,
        runId,
        coversSeqs: [range.fromSeq, range.toSeq],
        sourceEventCount: events.length,
      })
    } catch (error) {
      // 压缩失败不阻断这一轮：降级为纯裁剪，并记一条状态事件（复盘能看出"这里本该有摘要"）
      this.logger.warn('ai.context.compact_failed', {
        conversationId,
        runId,
        reason: error instanceof Error ? error.message : String(error),
      })
      await this.timelines.append({
        conversationId,
        runId,
        role: TimelineRole.System,
        kind: TimelineKind.Status,
        payload: {
          status: 'compact_failed_fallback_trim',
          coversSeqs: [range.fromSeq, range.toSeq],
        },
        finishedAt: new Date(),
      })
    }
  }

  /** 把 Mastra 的 step 结果拆成时间线事件（文本 / 推理 / 工具调用与结果 / 每步用量） */
  private async persistSteps(
    conversationId: string,
    runId: string,
    steps: StepLike[],
  ): Promise<{ toolCallCount: number }> {
    let toolCallCount = 0
    for (const [index, step] of steps.entries()) {
      const messageId = `msg_${runId}_${index}`
      const items: Array<Record<string, unknown>> = []

      // 推理（只审计；组装上下文时不回灌，见 ContextService）
      const reasoning = this.joinReasoning(step)
      if (reasoning) {
        items.push({
          role: TimelineRole.Assistant,
          kind: TimelineKind.Reasoning,
          messageId,
          payload: { text: reasoning },
        })
      }
      if (step.text) {
        items.push({
          role: TimelineRole.Assistant,
          kind: TimelineKind.Text,
          messageId,
          payload: { text: step.text },
        })
      }
      for (const call of step.toolCalls ?? []) {
        const payload = call.payload ?? {}
        toolCallCount += 1
        items.push({
          role: TimelineRole.Assistant,
          kind: TimelineKind.ToolCall,
          messageId,
          toolKey: payload.toolName ?? null,
          toolCallId: payload.toolCallId ?? null,
          payload: {
            toolCallId: payload.toolCallId ?? null,
            toolName: payload.toolName ?? null,
            input: payload.args ?? null,
          },
        })
      }
      for (const toolResult of step.toolResults ?? []) {
        const payload = toolResult.payload ?? {}
        items.push({
          role: TimelineRole.Assistant,
          kind: TimelineKind.ToolResult,
          messageId,
          state: payload.isError ? 'output-error' : 'output-available',
          toolKey: payload.toolName ?? null,
          toolCallId: payload.toolCallId ?? null,
          payload: {
            toolCallId: payload.toolCallId ?? null,
            toolName: payload.toolName ?? null,
            // **出参完整落库，不裁剪**
            output: payload.result ?? null,
            isError: payload.isError ?? false,
          },
        })
        // 规划能力：write-plan 的输出额外落一条 `plan` 事件 —— **当前计划 = 最后一条 plan 事件**，
        // 且"什么时候把哪一步标成完成"成为可复盘的历史
        const plan = toPlanPayload(payload.toolName ?? null, payload.result)
        if (plan) {
          items.push({
            role: TimelineRole.Assistant,
            kind: TimelineKind.Plan,
            messageId,
            payload: plan as unknown as Record<string, unknown>,
          })
        }
      }
      // 每个模型调用步落一行（带该步的 token 与边界）
      items.push({
        role: TimelineRole.Assistant,
        kind: TimelineKind.Step,
        messageId,
        usage: toUsageRecord(step.usage as Record<string, unknown> | undefined),
        payload: {
          stepIndex: index,
          finishReason: step.finishReason ?? null,
        },
      })

      const finishedAt = new Date()
      await this.timelines.appendMany(
        items.map((item) => ({
          conversationId,
          runId,
          messageId,
          startedAt: finishedAt,
          finishedAt,
          ...item,
        })) as never,
      )
    }
    return { toolCallCount }
  }

  /** 汇总一步里的推理增量文本 */
  private joinReasoning(step: StepLike): string {
    const chunks = step.reasoning ?? []
    return chunks
      .map((chunk) => {
        const text = chunk.payload?.text
        return typeof text === 'string' ? text : ''
      })
      .join('')
      .trim()
  }

  /**
   * 流式一轮问答（`POST /agent/chat/stream`）。
   *
   * 与 {@link chat} 共用前半段（会话 / 运行 / 上下文 / 用户消息落库），
   * 差别在产出：这里把流写给客户端，同时**每个片段落三处**（时间线 / 输出记录 / 广播）。
   */
  async chatStream(
    userId: string,
    input: AgentChatDto,
    response: StreamResponseLike,
  ): Promise<void> {
    const mastra = this.requireMastra()
    const conversation = await this.resolveConversation(userId, input)
    const definition = this.registry.resolve(input.agentKey ?? conversation.agentKey)
    const run = await this.startRun(conversation, definition.key, userId)
    const startedAt = Date.now()

    // 本轮模型：**只能来自库里的配置**（解析失败直接抛，连流都不建）
    const model = await this.resolveRuntimeModel(definition, input.modelId)

    let built = await this.buildContext(conversation.id, definition, input.message, model)
    if (built.needsCompaction && built.compactionRange) {
      // 注意：这一步在建流之前，**此时还没有中止控制器**（`abort` 后面才声明）→ 信封不带 abortSignal
      await this.summarize(
        conversation.id,
        run.id,
        definition,
        built.compactionRange,
        await this.buildRuntimeContext(conversation.id, run.id, definition, userId, model),
      )
      built = await this.buildContext(conversation.id, definition, input.message, model)
    }

    const now = new Date()
    await this.timelines.append({
      conversationId: conversation.id,
      runId: run.id,
      role: TimelineRole.User,
      kind: TimelineKind.Text,
      payload: { text: input.message },
      startedAt: now,
      finishedAt: now,
    })

    const streamId = `${run.id}-${Date.now()}`
    const abort = new AbortController()
    this.activeRuns.set(run.id, abort)
    await this.runs.setActiveStream(run.id, streamId)
    await this.streamStore.startRun(run.id, {
      status: RunStatus.Running,
      stage: 'generating',
      streamId,
      offset: 0,
      step: 0,
    })

    const recorder = new StreamRecorder(this.timelines, {
      conversationId: conversation.id,
      runId: run.id,
    })
    let offset = 0
    let stepCount = 0
    let lastProgressAt = 0

    // 心跳：SSE 注释帧。间隔必须显著小于网关空闲超时（默认 15s < keepAliveTimeout 75s），
    // 否则"AI 想得久一点就断流"。自己写而不用 `withSseHeartbeat`：后者收的是 Web Response。
    const heartbeat = setInterval(() => {
      if (!response.writableEnded) response.write(': ping\n\n')
    }, STREAM_HEARTBEAT_MS)

    // 跨副本停止：订阅本 run 的停止频道（请求落在别的副本时也停得掉）
    let unsubscribeStop: (() => Promise<void>) | null = null
    try {
      unsubscribeStop = await this.streamStore.subscribeRun(
        run.id,
        () => undefined,
        () => abort.abort(),
      )
    } catch (error) {
      this.logger.warn('ai.stream.stop_subscribe_failed', {
        runId: run.id,
        reason: error instanceof Error ? error.message : String(error),
      })
    }

    try {
      const requestContext = await this.buildRuntimeContext(
        conversation.id,
        run.id,
        definition,
        userId,
        model,
        abort.signal,
      )
      const agent = mastra.getAgent(definition.key)
      const output = await agent.stream(built.messages as never, {
        maxSteps: AGENT_MAX_STEPS,
        abortSignal: abort.signal,
        requestContext,
      })
      // 子 agent 的实时明细**不走** Mastra 的静态子 agent 通道（我们没有静态子 agent）：
      // 由 `run-sub-agent` 工具经 `context.writer` 写成 `data-sub-agent*` 块进这条流，见 §3.14.5
      const uiStream = toAISdkStream(output, {
        from: 'agent',
        version: 'v6',
        sendReasoning: true,
        sendSources: true,
      })

      const recorded = (uiStream as unknown as ReadableStream<UiChunkLike>).pipeThrough(
        new TransformStream<UiChunkLike, UiChunkLike>({
          transform: async (chunk, controller) => {
            // 先给客户端，再落库：用户的体感不该被落库拖慢
            controller.enqueue(chunk)
            try {
              await recorder.consume(chunk)
              offset = await this.streamStore.appendChunk(run.id, chunk)
              await this.streamStore.publishChunk(run.id, chunk)
              if (chunk.type === 'start-step') stepCount += 1
              const nowMs = Date.now()
              if (nowMs - lastProgressAt >= STREAM_PROGRESS_THROTTLE_MS) {
                lastProgressAt = nowMs
                await this.streamStore.patchRun(run.id, {
                  stage:
                    chunk.type === 'tool-input-available'
                      ? `tool:${chunk.toolName ?? ''}`
                      : 'generating',
                  offset,
                  step: stepCount,
                  heartbeatAt: new Date().toISOString(),
                })
                await this.runs.touchHeartbeat(run.id)
              }
            } catch (error) {
              // 录制失败不掐断用户正在看的流：记日志继续（真相仍在，稍后可补）
              this.logger.warn('ai.stream.record_failed', {
                runId: run.id,
                reason: error instanceof Error ? error.message : String(error),
              })
            }
          },
        }),
      )

      // 手写流而不是用 `pipeUIMessageStreamToResponse`：要自己控制"什么时候结束响应"——
      // **收尾（终态 / 消耗 / 统计）落库之后才发 `[DONE]`**，于是客户端看到 `[DONE]`
      // 就代表服务端已经落好终态（否则会出现"收到 [DONE] 但查运行还是 running"的窗口）。
      response.writeHead(200, UI_STREAM_HEADERS)
      response.flushHeaders?.()

      // 先把"这一轮的身份"发给客户端：**前端要靠它记住 runId**（停止与断线重连都只认 runId）。
      // 它走与业务片段**同一条记录 + 广播通道**，所以补发连接也一定会先拿到它。
      const runHead = {
        type: 'data-run',
        data: { runId: run.id, conversationId: conversation.id, agentKey: definition.key },
      }
      if (!response.writableEnded) response.write(sseFrame(runHead))
      offset = await this.streamStore.appendChunk(run.id, runHead)
      await this.streamStore.publishChunk(run.id, runHead)

      const reader = recorded.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (response.writableEnded) break
        response.write(sseFrame(value))
      }

      // 被中止时 Mastra 会**正常返回**（流被截断但不抛错）→ 必须自己判定"这不是成功，是取消"
      if (abort.signal.aborted) {
        await recorder.flushPending()
        throw new Error('stream_aborted_by_user')
      }
      // 收尾前把没有 text-end 的残余内容也落库（防御性：正常结束一般不会有）
      await recorder.flushPending()

      // 收尾：**先 Postgres 终态，再清 Redis 进度**（反过来会留下"没进度也没结果"的窗口）
      const steps = (await output.steps) as unknown as StepLike[]
      const usage = await this.rollUpUsage(
        run.id,
        toUsageRecord((await output.totalUsage) as unknown as Record<string, unknown>),
      )
      const persisted = await recorder.finish(steps)
      const durationMs = Date.now() - startedAt
      await this.runs.finish(run.id, {
        status: RunStatus.Succeeded,
        usage,
        stepCount: steps.length,
        toolCallCount: persisted.toolCallCount,
        durationMs,
      })
      await this.runs.setActiveStream(run.id, null)
      await this.runs.saveRequestSnapshot(run.id, {
        model: model.modelRef,
        agentKey: definition.key,
        toolKeys: [...definition.tools],
        skillKeys: [...definition.skills],
        params: { maxSteps: AGENT_MAX_STEPS },
        context: built.snapshot,
      })
      await this.conversationRepo.accumulate(conversation.id, totalTokensOf(usage))
      if (!conversation.title) {
        await this.conversationRepo.setTitle(conversation.id, titleFrom(input.message))
      }
      this.logger.log('ai.stream.succeeded', {
        conversationId: conversation.id,
        runId: run.id,
        stepCount: steps.length,
        toolCallCount: persisted.toolCallCount,
        durationMs,
      })

      // 终态已落库 → 现在才告诉客户端"这一轮结束"
      if (!response.writableEnded) {
        response.write('data: [DONE]\n\n')
        response.end()
      }
    } catch (error) {
      const durationMs = Date.now() - startedAt
      const reason = error instanceof Error ? error.message : String(error)
      if (abort.signal.aborted) {
        // 用户主动停止：是 canceled，不是 failed（语义要分清）
        await this.runs.finish(run.id, { status: RunStatus.Canceled, durationMs })
        await this.timelines.append({
          conversationId: conversation.id,
          runId: run.id,
          role: TimelineRole.System,
          kind: TimelineKind.Status,
          payload: { status: RunStatus.Canceled, reason: 'user_stopped', operator: userId },
          finishedAt: new Date(),
        })
        this.logger.log('ai.stream.canceled', { runId: run.id, durationMs })
      } else {
        // 响应头已发出：不能抛（会把"流里的错误"变成无声失败），错误已随 error chunk 给到客户端
        const mapped = classifyModelError(error)
        await this.runs.finish(run.id, {
          status: RunStatus.Failed,
          // 失败也要把子 agent 已经烧掉的 token 记在账上
          usage: await this.rollUpUsage(run.id, null),
          errorCode: String((mapped as { code?: number }).code ?? AppErrorCodes.AgentFailed),
          errorStage: RunErrorStage.Model,
          errorMessage: mapped.message,
          errorDetail: { raw: reason },
          durationMs,
        })
        await this.timelines.append({
          conversationId: conversation.id,
          runId: run.id,
          role: TimelineRole.System,
          kind: TimelineKind.Error,
          payload: { message: mapped.message, stage: RunErrorStage.Model },
          finishedAt: new Date(),
        })
        this.logger.error('ai.stream.failed', { runId: run.id, reason, durationMs })
      }
      await this.runs.setActiveStream(run.id, null)
      if (!response.writableEnded) {
        // 失败也要给客户端一个明确收尾（错误本身已随 error chunk 下发）
        response.write('data: [DONE]\n\n')
        response.end()
      }
    } finally {
      clearInterval(heartbeat)
      if (unsubscribeStop) await unsubscribeStop()
      this.activeRuns.delete(run.id)
      // 通知"还在补发中的重连连接"：本轮结束了（同一条流协议里的结束标记）
      try {
        await this.streamStore.publishChunk(run.id, { type: STREAM_END_MARKER })
      } catch {
        // 广播失败无碍：补发连接会被客户端的 idle 处理或下一次刷新收敛
      }
      await this.streamStore.clearRun(run.id)
      if (!response.writableEnded) response.end()
    }
  }

  /** 停止某一轮：本进程直接 abort；不在本进程则广播（跨副本） */
  async stopRun(userId: string, runId: string): Promise<AgentRunStopResultModel> {
    const run = await this.runs.findEntity(runId)
    if (!run) throw new RunNotFoundError(runId)
    await this.conversations.requireOwned(userId, run.conversationId)

    const controller = this.activeRuns.get(runId)
    if (controller) {
      controller.abort()
      return { stopped: true, injected: 'local' }
    }
    await this.streamStore.publishStop(runId)
    return { stopped: true, injected: 'broadcast' }
  }

  /**
   * 断线重连（**不报 runId 的版本**，`GET /agent/run/stream?offset=N`）：
   *
   * 页面刷新 / 换设备后，前端并不知道 runId（它只在流里的 `data-run` 块里给过一次）。
   * 与其让前端把它存进 localStorage（换设备就丢），不如按**登录用户**在库里找"当前进行中的那一轮"
   * —— 真相在 Postgres，浏览器只是个显示器。
   *
   * 返回 false 表示当前没有进行中的运行 → 控制器回 204（AI SDK 的续传约定，客户端静默收尾）。
   */
  async resumeCurrentRun(
    userId: string,
    offset: number,
    response: StreamResponseLike,
  ): Promise<boolean> {
    const active = await this.runs.findActiveByUser(userId)
    if (!active) return false
    return this.resumeRun(userId, active.id, offset, response)
  }

  /**
   * 断线重连（`GET /agent/run/:runId/stream?offset=N`）：
   * 先从 Redis 输出记录**补发** `offset` 之后的片段（不重跑、不重复扣费），再接实时广播。
   *
   * 返回 false 表示"没有进行中的流" → 控制器回 204（AI SDK 的续传约定）。
   */
  async resumeRun(
    userId: string,
    runId: string,
    offset: number,
    response: StreamResponseLike,
  ): Promise<boolean> {
    const run = await this.runs.findEntity(runId)
    if (!run) throw new RunNotFoundError(runId)
    await this.conversations.requireOwned(userId, run.conversationId)

    const progress = await this.streamStore.readRun(runId)
    if (!progress || progress.status !== RunStatus.Running) return false

    response.writeHead(200, UI_STREAM_HEADERS)
    response.flushHeaders?.()

    const backlog = (await this.streamStore.readChunks(runId, offset)) as UiChunkLike[]
    let ended = false
    for (const chunk of backlog) {
      if (chunk?.type === STREAM_END_MARKER) {
        ended = true
        break
      }
      if (!response.writableEnded) response.write(sseFrame(chunk))
    }
    if (ended) {
      if (!response.writableEnded) response.end()
      return true
    }

    // 挂住连接，转发实时片段直到客户端断开或本轮结束
    await new Promise<void>((resolve) => {
      let unsubscribe: (() => Promise<void>) | null = null
      const finish = (): void => {
        void unsubscribe?.()
        resolve()
      }
      response.on('close', finish)
      void this.streamStore
        .subscribeRun(
          runId,
          (chunk) => {
            const typed = chunk as UiChunkLike
            if (typed?.type === STREAM_END_MARKER) {
              finish()
              return
            }
            if (!response.writableEnded) response.write(sseFrame(chunk))
          },
          () => undefined,
        )
        .then((fn) => {
          unsubscribe = fn
        })
        .catch(() => finish())
    })
    if (!response.writableEnded) response.end()
    return true
  }

  /**
   * 组装并放入**运行时信封**（`requestContext`）。
   *
   * 为什么由编排层算：`run-sub-agent` 工具需要"子 agent 能用哪些工具"，
   * 而这依赖 `ToolBuilder`；若让 core bean 自己注入 `ToolBuilder`，装配会成环
   * （ToolBuilder 依赖 core bean）。信封把这份依赖倒过来，见设计文档 §3.14.4。
   */
  private async buildRuntimeContext(
    conversationId: string,
    parentRunId: string,
    definition: AgentDefinition,
    userId: string,
    model: RuntimeModel,
    abortSignal?: AbortSignal,
  ): Promise<RequestContext> {
    const envelope: AgentRuntimeEnvelope = {
      conversationId,
      parentRunId,
      triggeredBy: userId,
      depth: 0,
      model,
      // 子 agent 的工具面 = 全部 − 委派类（于是它不能再造子 agent，深度天然为 1）
      childTools: this.toolBuilder.buildDelegable(),
      childSkills: await this.skillLoader.resolve(definition.skills),
      ...(abortSignal ? { abortSignal } : {}),
    }
    const requestContext = new RequestContext()
    requestContext.setRaw(AGENT_RUNTIME_KEY, envelope)
    return requestContext
  }

  /**
   * 把子 agent 的消耗汇总进父 run（**父的合计已含子**）。
   *
   * 会话累计只按根 run 累加，所以全链路只算一次钱；子 agent 自己那一份仍留在它自己的 run 里，
   * 父的 `usage.subAgents` 保留子的明细（谁的活花了多少，两边都查得到）。
   */
  private async rollUpUsage(
    runId: string,
    own: Record<string, unknown> | null,
  ): Promise<Record<string, unknown> | null> {
    const children = await this.runs.listChildUsages(runId)
    if (children.length === 0) return own
    const subAgents = mergeUsage(...children)
    return { ...(own ?? {}), subAgents, ...(mergeUsage(own, subAgents) ?? {}) }
  }

  private requireMastra(): Mastra {
    if (!this.mastra) throw new AgentUnavailableError()
    return this.mastra
  }
}

/** Mastra step 结果的最小结构（只取我们要落库的字段，避免把它的内部类型铺满本文件） */
interface StepLike {
  text?: string
  reasoning?: Array<{ payload?: { text?: string } }>
  toolCalls?: Array<{
    payload?: { toolCallId?: string; toolName?: string; args?: unknown }
  }>
  toolResults?: Array<{
    payload?: {
      toolCallId?: string
      toolName?: string
      result?: unknown
      isError?: boolean
    }
  }>
  usage?: unknown
  finishReason?: string
}

/** 时间线事件（仅用于类型收口） */
export type { TimelineEntity }

/**
 * 流式编排与停止 / 重连（挂在 `AgentChatService` 上，复用同一套会话、上下文、落库与收尾逻辑）。
 *
 * 关键点（设计文档 §5.3 / §3.10 / §3.13）：
 * - 流用 AI SDK 的 UI Message Stream 协议写给客户端（`useChat` 直接消费）；
 * - 每个片段**同时**落三处：时间线（真相）、Redis 输出记录（补发）、pub/sub（跨副本转发）；
 * - 心跳用 SSE 注释帧自己写（`@mastra/ai-sdk` 的 `withSseHeartbeat` 收的是 Web Response，这里是 Express）；
 * - 停止：本进程 abort + 跨副本经 Redis 频道广播；
 * - 重连：按 `offset` 从输出记录补发，再接实时；没有进行中的流则回 204。
 */
export const STREAM_HEARTBEAT_MS = 15_000
export const STREAM_PROGRESS_THROTTLE_MS = 1_000

/** 流式片段的最小结构（录制器与转发共用） */
interface UiChunkLike {
  type?: string
  toolName?: string
  messageId?: string
}

/** Express Response 的最小接口（只在编排层用，避免把 express 类型铺进来） */
export interface StreamResponseLike {
  writeHead: (status: number, headers: Record<string, string>) => unknown
  flushHeaders?: () => void
  write: (chunk: string) => unknown
  end: () => unknown
  status?: (code: number) => { end: () => unknown }
  writableEnded?: boolean
  on: (event: string, handler: () => void) => unknown
}

/** 输出记录里的"本轮结束"标记（补发连接见到它就收尾） */
export const STREAM_END_MARKER = '__run_end__'

const UI_STREAM_HEADERS: Record<string, string> = {
  'content-type': 'text/event-stream',
  'cache-control': 'no-cache',
  connection: 'keep-alive',
  // 协议自描述（官方客户端不校验，但自建后端写上便于排查）与关掉网关缓冲
  'x-vercel-ai-ui-message-stream': 'v1',
  'x-accel-buffering': 'no',
}

const sseFrame = (chunk: unknown): string => `data: ${JSON.stringify(chunk)}\n\n`
