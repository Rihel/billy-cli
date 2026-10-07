import { Inject, Injectable } from '@nestjs/common';
import dedent from 'dedent';
import { AppError, AppLogger } from '@repo/kits';
import {
  AppErrorCodes,
  RunErrorStage,
  RunStatus,
  TimelineKind,
  TimelineRole,
  estimateContentTokens,
  type AgentChatDto,
  type AgentChatResultModel,
  type AgentRunStopResultModel,
  type ChatAttachmentModel,
} from '@repo/shared';
import type { Mastra } from '@mastra/core/mastra';
import { RequestContext } from '@mastra/core/request-context';
import { AGENT_MAX_STEPS } from '../core/constants.js';
import {
  AgentConfig,
  type AgentConfig as AgentConfigValue,
} from '../core/config.js';
import {
  AgentFailedError,
  AgentUnavailableError,
  ConversationBusyError,
  ProviderAuthFailedError,
  ProviderRateLimitedError,
  RunNotFoundError,
} from '../core/errors.js';
import { AGENT_REGISTRY } from '../agents/registry.js';
import { MASTRA } from '../mastra/ai.mastra.js';
import {
  AGENT_RUNTIME_KEY,
  type AgentRuntimeEnvelope,
  type RuntimeModel,
} from '../core/envelope.js';
import { AiModelService } from '../../ai-model/index.js';
import type { ResolvedRuntimeModel } from '../../ai-model/index.js';
import type { AgentDefinition, AgentRegistry } from '../agents/types.js';
import { buildEnvironmentData } from '../core/prompts/environment.js';
import {
  PROMPT_ENGINE,
  type PromptEngine,
} from '../core/prompts/prompt.engine.js';
import { SkillLoader } from '../core/skills/index.js';
import { ToolRegistry } from '../core/tools/tool.registry.js';
import { ToolCallMetaStore } from '../core/tools/tool.meta.js';
import { toUiStream } from '../mastra/stream.adapter.js';
import { toMastraModelInstance } from '../mastra/agent.adapter.js';
import { toRequestContext } from '../mastra/context.adapter.js';
import type { ConversationEntity } from '../../../database/entities/conversation-entity.js';
import type { TimelineEntity } from '../../../database/entities/timeline-entity.js';
import { AgentConversationService } from './conversation.service.js';
import { AgentTitleService, type FirstTurnTitle } from './title.service.js';
import { ContextService } from './context.service.js';
import {
  ChatAttachmentService,
  withUserContent,
} from './chat-attachment.service.js';
import { ConversationRepository } from './conversation.repository.js';
import { RunRepository } from './run.repository.js';
import { TimelineRepository } from './timeline.repository.js';
import { AgentStreamStore } from './stream-store.service.js';
import { StreamRecorder } from './stream-recorder.js';
import { readStreamSteps, readStreamUsage } from './stream-result.js';
import { toPlanPayload } from './plan.protocol.js';
import { mergeUsage, toUsageRecord, totalTokensOf } from './usage.js';

/** 并发保护的唯一索引名（同一会话同时只允许一轮进行中） */
const ACTIVE_RUN_CONSTRAINT = 'uk_run_active_conversation';

/** PG 错误的最小结构（TypeORM 会把它放在 driverError 里） */
interface PgError {
  code?: string;
  constraint?: string;
  detail?: string;
}

/** 生成摘要用的指令（只做压缩，不做回答） */
const SUMMARY_INSTRUCTION = dedent`
  请把上面的对话压缩成一份简明摘要，供后续对话继续使用。
  要求：
  1. 保留事实（用户是谁、问过什么、结论是什么、涉及的具体数据）；
  2. 保留未完成的事项与用户明确的偏好；
  3. 不要评价、不要扩写、不要编造；
  4. 用简体中文，控制在 500 字以内。
`;

/** 摘要正文之外，摘要事件还要记住它覆盖了哪一段 */
const SUMMARY_MAX_CHARS = 2_000;

/** 用首条用户消息生成会话标题（不额外调模型，省钱） */
const titleFrom = (message: string): string =>
  message.replace(/\s+/g, ' ').trim().slice(0, 40);

/**
 * 用户消息的落库载荷。
 *
 * 没有附件时形状与过去**逐字节一致**（`{ text }`）—— 历史数据与既有渲染路径不受影响；
 * 有附件才多一个 `attachments`（只存存储 key 与文件元数据，**不存文件内容**：
 * 图片转 base64 动辄几 MB，塞进 jsonb 会把这张审计表撑变形，回看历史时按 key 再解析即可）。
 */
const userMessagePayload = (input: AgentChatDto): Record<string, unknown> =>
  input.attachments && input.attachments.length > 0
    ? { text: input.message, attachments: input.attachments }
    : { text: input.message };

/**
 * 上游错误分类：鉴权失败 / 限流 单独成码，其余归通用失败。
 *
 * **我们自己抛的业务错（`AppError` 家族）原样返回**（踩过）：早先这里无条件包一层
 * `AgentFailedError`，于是 3402「模型已禁用」/3406「还没配模型」这些**明确、可行动**的错误码
 * 全被降级成 3302「AI 回复失败」—— 前端只能显示一句泛泛的失败，
 * "去后台启用模型"这种修复动作就传递不出去（错误码的意义正在于此）。
 */
const classifyModelError = (error: unknown): Error => {
  if (error instanceof AppError) return error;
  const raw = error instanceof Error ? error.message : String(error);
  const lower = raw.toLowerCase();
  if (
    lower.includes('401') ||
    lower.includes('unauthorized') ||
    lower.includes('invalid api key') ||
    lower.includes('incorrect api key')
  ) {
    return new ProviderAuthFailedError(raw);
  }
  if (
    lower.includes('429') ||
    lower.includes('rate limit') ||
    lower.includes('too many requests')
  ) {
    return new ProviderRateLimitedError(raw);
  }
  return new AgentFailedError(raw);
};

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
    @Inject(AgentConversationService)
    private readonly conversations: AgentConversationService,
    @Inject(ConversationRepository)
    private readonly conversationRepo: ConversationRepository,
    @Inject(RunRepository) private readonly runs: RunRepository,
    @Inject(TimelineRepository) private readonly timelines: TimelineRepository,
    @Inject(ContextService) private readonly context: ContextService,
    @Inject(ChatAttachmentService)
    private readonly attachments: ChatAttachmentService,
    @Inject(AgentStreamStore) private readonly streamStore: AgentStreamStore,
    @Inject(ToolRegistry) private readonly toolRegistry: ToolRegistry,
    @Inject(ToolCallMetaStore) private readonly toolMetas: ToolCallMetaStore,
    @Inject(SkillLoader) private readonly skillLoader: SkillLoader,
    @Inject(AiModelService) private readonly models: AiModelService,
    @Inject(AppLogger) private readonly logger: AppLogger,
    @Inject(PROMPT_ENGINE) private readonly prompts: PromptEngine,
    @Inject(AgentTitleService) private readonly titles: AgentTitleService,
  ) {}

  /**
   * **首轮结束时给会话起名**（模型生成、≤10 字、与当前 agent 上下文完全隔离）。
   *
   * 三个前提全满足才做；任何一条不满足就返回 null（保住"首条消息"那版兜底标题）：
   * 1. **这一轮是首轮**（开局时 `turnCount === 0`，第一轮之后不再改名）；
   * 2. 标题**还是兜底那版** —— 用户中途改过名就永远听用户的，后台不许悄悄冲掉它；
   * 3. 命名调用成功且从模型输出里收拾出了名字（超时 / 报错 / 空输出都算失败）。
   *
   * 为什么这次调用的 token 计进这一轮：`runs.usage` 的语义是"这一轮花掉的钱"，
   * 为这一轮起的名字正是这一轮花的 —— 分开记会让账目凭空少一块（它不占 `step` 行，
   * 因为它不是回答的一步）。
   */
  private async generateFirstTurnTitle(
    conversation: ConversationEntity,
    runId: string,
    message: string,
    model: RuntimeModel,
  ): Promise<FirstTurnTitle | null> {
    if (conversation.turnCount > 0) return null;
    if (conversation.title && conversation.title !== titleFrom(message))
      return null;
    return this.titles.generateFirstTurnTitle({
      conversationId: conversation.id,
      runId,
      model,
    });
  }

  /** 落标题：模型起的名优先；没起成则只在标题为空时用首条消息兜底（用户改过的名不动） */
  private async applyTitle(
    conversation: ConversationEntity,
    message: string,
    generated: FirstTurnTitle | null,
  ): Promise<void> {
    if (generated?.title) {
      await this.conversationRepo.setTitle(conversation.id, generated.title);
      return;
    }
    if (!conversation.title) {
      await this.conversationRepo.setTitle(conversation.id, titleFrom(message));
    }
  }

  /** 本进程内活动运行的中止控制器（跨副本经 Redis 停止频道广播） */
  private readonly activeRuns = new Map<string, AbortController>();

  async chat(
    userId: string,
    input: AgentChatDto,
    isAdmin = false,
  ): Promise<AgentChatResultModel> {
    const mastra = this.requireMastra();
    const conversation = await this.resolveConversation(userId, input);
    const definition = this.registry.resolve(
      input.agentKey ?? conversation.agentKey,
    );

    const run = await this.startRun(conversation, definition.key, userId);
    const startedAt = Date.now();

    try {
      // ① 解析本轮模型（**只能来自库里的配置**；解析不出来直接 3406/3402，不建流不烧钱）
      const model = await this.resolveRuntimeModel(definition, input.modelId);
      const modelInstance = await this.resolveModelInstance(model);

      // ② 组装上下文（窗口优先用库里配的实测值；超限则先压缩一次再重新组装，只压一次）
      let built = await this.buildContext(
        conversation.id,
        definition,
        input.message,
        model,
        input.attachments,
      );
      if (built.needsCompaction && built.compactionRange) {
        const requestContextForSummary = await this.buildRuntimeContext(
          conversation.id,
          run.id,
          definition,
          userId,
          model,
        );
        await this.summarize(
          conversation.id,
          run.id,
          definition,
          built.compactionRange,
          requestContextForSummary,
        );
        built = await this.buildContext(
          conversation.id,
          definition,
          input.message,
          model,
          input.attachments,
        );
      }

      // ② 用户消息先落库（之后无论成败，审计上都能看到"用户问了什么"）
      const now = new Date();
      await this.timelines.append({
        conversationId: conversation.id,
        runId: run.id,
        role: TimelineRole.User,
        kind: TimelineKind.Text,
        payload: userMessagePayload(input),
        startedAt: now,
        finishedAt: now,
      });

      // ④ 调模型（工具往返都在这一步内部完成；运行时信封带"这一轮用哪个模型"+ 开局环境）
      const requestContext = await this.buildRuntimeContext(
        conversation.id,
        run.id,
        definition,
        userId,
        model,
        {
          systemPrompt: await this.resolveSystemPrompt(
            conversation,
            run.id,
            definition,
          ),
        },
      );
      const agent = mastra.getAgent(definition.key);
      const result = await agent.generate(built.messages as never, {
        maxSteps: AGENT_MAX_STEPS,
        requestContext,
        // 显式传模型实例：不依赖 Agent 上的动态 model（Mastra 自解析配置那一层曾丢过多模态，见 resolveModelInstance）
        model: modelInstance as never,
        // 与流式同一口径：引擎 runId 由我们定、并回写到 `runs.engine_run_id`（durable 快照靠它认亲）
        runId: run.engineRunId,
      });

      // ④ 逐事件落时间线（保真：文本 / 推理 / 工具入参出参 / 每步用量）
      const steps = (result.steps ?? []) as unknown as StepLike[];
      const persisted = await this.persistSteps(conversation.id, run.id, steps);

      // ⑤ 首轮命名：把这一轮的记录交给模型起个短名（与 agent 上下文完全隔离的一次小调用）
      const title = await this.generateFirstTurnTitle(
        conversation,
        run.id,
        input.message,
        model,
      );

      // ⑤ 收尾：终态 + 消耗（含子 agent 汇总与这次命名）+ 统计 + 会话累计 + 标题
      const usageBase = await this.rollUpUsage(
        run.id,
        toUsageRecord(result.totalUsage ?? result.usage ?? null),
      );
      // 并账要**保留 usageBase 里的非 token 字段**（如 `subAgents`）：
      // `mergeUsage` 只逐字段加 token，直接把它的结果当 usage 会把那些字段抹掉（踩过：子 agent 明细消失）
      const usage = title?.usage
        ? { ...usageBase, ...(mergeUsage(usageBase, title.usage) ?? {}) }
        : usageBase;
      const durationMs = Date.now() - startedAt;
      await this.runs.finish(run.id, {
        status: RunStatus.Succeeded,
        usage,
        stepCount: steps.length,
        toolCallCount: persisted.toolCallCount,
        durationMs,
      });
      await this.runs.saveRequestSnapshot(run.id, {
        model: model.modelRef,
        agentKey: definition.key,
        toolKeys: [...definition.tools],
        skillKeys: [...definition.skills],
        params: { maxSteps: AGENT_MAX_STEPS },
        context: built.snapshot,
      });
      await this.conversationRepo.accumulate(
        conversation.id,
        totalTokensOf(usage),
      );
      await this.applyTitle(conversation, input.message, title);

      this.logger.log('ai.chat.succeeded', {
        conversationId: conversation.id,
        runId: run.id,
        agentKey: definition.key,
        stepCount: steps.length,
        toolCallCount: persisted.toolCallCount,
        durationMs,
      });

      return {
        conversationId: conversation.id,
        runId: run.id,
        status: RunStatus.Succeeded,
        content: (result.text as string) ?? '',
        stepCount: steps.length,
        toolCallCount: persisted.toolCallCount,
        usage,
        durationMs,
      };
    } catch (error) {
      const mapped = classifyModelError(error);
      const durationMs = Date.now() - startedAt;
      const message = mapped.message;
      await this.runs.finish(run.id, {
        status: RunStatus.Failed,
        // 失败也要把子 agent 已经烧掉的 token 记在账上（否则这笔钱在库里查不到）
        usage: await this.rollUpUsage(run.id, null),
        errorCode: String(
          (mapped as { code?: number }).code ?? AppErrorCodes.AgentFailed,
        ),
        errorStage: RunErrorStage.Model,
        errorMessage: message,
        // 上游原文全量保留（脱敏在日志层做；这里不做截断 —— 审计要能查原话）
        errorDetail: { raw: message },
        durationMs,
      });
      await this.timelines.append({
        conversationId: conversation.id,
        runId: run.id,
        role: TimelineRole.System,
        kind: TimelineKind.Error,
        payload: { message, stage: RunErrorStage.Model },
        finishedAt: new Date(),
      });
      this.logger.error('ai.chat.failed', {
        conversationId: conversation.id,
        runId: run.id,
        reason: message,
        durationMs,
      });
      throw mapped;
    }
  }

  /** 会话：给了 id 就校验归属；没给就新建 */
  private async resolveConversation(
    userId: string,
    input: AgentChatDto,
  ): Promise<ConversationEntity> {
    if (input.conversationId) {
      return this.conversations.requireOwned(userId, input.conversationId);
    }
    const created = await this.conversations.create(userId, {
      agentKey: input.agentKey,
    });
    const entity = await this.conversationRepo.findEntity(created.id);
    if (!entity) throw new AgentFailedError('会话创建后立即读取失败');
    return entity;
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
      });
      /**
       * **把引擎 runId 定死成我们这一行的 id**，起跑时就回写。
       *
       * 为什么必须在这里定：durable 的快照落库是
       * `UPDATE runs SET snapshot ... WHERE engine_run_id = :runId` —— 找不到宿主就**丢掉快照**
       * （`ai.storage.snapshot_orphan_skipped`）。而引擎 runId 由 Mastra 生成、我们原本拿不到，
       * 于是**所有快照都被丢掉**：库里 60 条运行、只有 13 条（早期手工造的）有快照，
       * 启动恢复因此永远找不到"没跑完的" —— "崩溃后能续跑"这条线等于没通。
       *
       * 现在由我们生成并同时交给 Mastra（`agent.stream(..., { runId })`），
       * 双方用同一个 id，快照就能落到正确那一行上。
       */
      const engineRunId = `eng_${run.id}`;
      await this.runs.markRunning(run.id, engineRunId);
      return { ...run, engineRunId };
    } catch (error) {
      // TypeORM 把 PG 的错误信息放在 `driverError` 里（顶层只有 message），两处都取一下
      const driver = (error as { driverError?: PgError }).driverError;
      const top = error as PgError;
      const code = driver?.code ?? top.code;
      const constraint = driver?.constraint ?? top.constraint ?? '';
      const detail = driver?.detail ?? top.detail ?? '';
      if (
        code === '23505' &&
        (constraint === ACTIVE_RUN_CONSTRAINT ||
          detail.includes(ACTIVE_RUN_CONSTRAINT))
      ) {
        throw new ConversationBusyError(conversation.id);
      }
      throw error;
    }
  }

  /**
   * 组装上下文（薄封装，便于以后在流式路径复用）。
   *
   * 附件在这里落地，顺序很关键：
   * 1. 先按存储 key 取回附件，拼出**当前用户消息**的多模态内容（图片 / 文件 / 内联文本）；
   * 2. 把这份内容的 token 成本交给 `ContextService` **参与裁剪与压缩的判断** ——
   *    不参与的话，一张图能让实际输入远超估算，我们会在"以为没超"的情况下把请求发出去挨上游 400；
   * 3. 组装完成后，把最后一条用户消息的 content 换成多模态内容（历史部分不受影响）。
   */
  private async buildContext(
    conversationId: string,
    definition: AgentDefinition,
    userMessage: string,
    model: RuntimeModel,
    /**
     * 本轮附件。
     *
     * 归属校验由 `ChatAttachmentService` 经 `AttachmentKeyPolicy` 在**读对象之前**完成
     * （它读的是请求上下文里的登录身份），这里不重复判。
     */
    attachments?: readonly ChatAttachmentModel[],
  ) {
    const hasAttachments = Boolean(attachments && attachments.length > 0);
    const userContent = hasAttachments
      ? await this.attachments.buildUserContent(
          userMessage,
          attachments,
          model.inputModalities,
        )
      : null;

    const built = await this.context.buildInput({
      conversationId,
      // 标识用 `<providerSlug>/<modelKey>`（ContextService 据此查窗口，查不到用兜底值）
      modelId: model.modelRef,
      systemPrompt: definition.instructions,
      userMessage,
      // 库里配过窗口就用它（实测值优先于 tokenlens 的估算）
      ...(model.contextWindow ? { windowTokens: model.contextWindow } : {}),
      ...(userContent
        ? { extraInputTokens: estimateContentTokens(userContent) }
        : {}),
    });

    if (!userContent) {
      return built;
    }
    /**
     * 把最后一条用户消息换成多模态内容。
     *
     * ⚠️ **别忘了 `agent.stream(..., { model })`**：不显式给模型实例的话，
     * 多模态内容曾在 Mastra 那一层被压平成纯字符串（图片静默丢失）。
     * 回归防线在 `ai-mastra-contract.test.ts` 的"durable 下的多模态"。
     */
    const injected = withUserContent(built.messages, userContent);
    return { ...built, messages: injected };
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
    return this.toRuntimeModel(
      await this.models.resolveForRuntime(modelId ?? definition.model),
    );
  }

  /**
   * 取"这一轮要用的**模型实例**"。
   *
   * 必须在调用 `agent.stream` / `agent.generate` 时显式传它：Agent 上挂的是**动态 model**
   * （每轮按信封求值），而 Mastra 在那条路径上会把多模态消息的 `content` 压平成纯字符串 ——
   * 图片被静默丢掉。详见 `toMastraModelInstance` 的注释与实测数据。
   */
  private async resolveModelInstance(model: RuntimeModel): Promise<unknown> {
    return (await toMastraModelInstance(model)).instance;
  }

  /** 解析结果 → 我们的运行时模型（含输入模态，供附件校验用） */
  private toRuntimeModel(resolved: ResolvedRuntimeModel): RuntimeModel {
    return {
      id: resolved.id,
      modelRef: resolved.modelRef,
      modelKey: resolved.modelKey,
      displayName: resolved.displayName,
      // 供应商类型：Mastra 的模型函数靠它决定走官方 SDK 还是通用 OpenAI 兼容（思考字段的成败在这）
      providerKind: resolved.providerKind,
      ...(resolved.baseURL ? { baseURL: resolved.baseURL } : {}),
      apiKey: resolved.apiKey,
      contextWindow: resolved.contextWindow,
      // 这个模型的输入模态：附件校验与"喂得进去吗"都看它（null = 未声明 → 不拦，只提示）
      inputModalities: resolved.inputModalities,
    };
  }

  /** 把一段旧对话压缩成摘要事件（原文保留，摘要只作"给模型看的新起点"） */
  private async summarize(
    conversationId: string,
    runId: string,
    definition: AgentDefinition,
    range: { fromSeq: number; toSeq: number },
    requestContext: RequestContext,
  ): Promise<void> {
    const mastra = this.requireMastra();
    const events = await this.timelines.listRange(
      conversationId,
      range.fromSeq,
      range.toSeq,
      {
        rootOnly: true,
      },
    );
    const lines: string[] = [];
    for (const event of events) {
      if (event.kind === TimelineKind.Text) {
        const text =
          typeof event.payload?.text === 'string' ? event.payload.text : '';
        if (text)
          lines.push(
            `${event.role === TimelineRole.User ? '用户' : '助手'}：${text}`,
          );
      } else if (event.kind === TimelineKind.ToolCall) {
        lines.push(
          `[工具调用] ${event.toolKey ?? '未知'} 入参：${JSON.stringify(event.payload?.input ?? {})}`,
        );
      } else if (event.kind === TimelineKind.ToolResult) {
        lines.push(
          `[工具结果] ${event.toolKey ?? '未知'} 出参：${JSON.stringify(event.payload?.output ?? null)}`,
        );
      }
    }
    if (lines.length === 0) return;

    const startedAt = new Date();
    const agent = mastra.getAgent(definition.key);
    try {
      const result = await agent.generate(
        [
          {
            role: 'user',
            content: `以下是需要压缩的历史对话：\n\n${lines.join('\n')}`,
          },
          { role: 'user', content: SUMMARY_INSTRUCTION },
        ] as never,
        // 动态模型要信封（否则模型函数不知道这一轮用哪个模型）
        { maxSteps: 1, requestContext },
      );
      const text = ((result.text as string) ?? '').slice(0, SUMMARY_MAX_CHARS);
      if (!text) return;
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
      });
      this.logger.log('ai.context.compacted', {
        conversationId,
        runId,
        coversSeqs: [range.fromSeq, range.toSeq],
        sourceEventCount: events.length,
      });
    } catch (error) {
      // 压缩失败不阻断这一轮：降级为纯裁剪，并记一条状态事件（复盘能看出"这里本该有摘要"）
      this.logger.warn('ai.context.compact_failed', {
        conversationId,
        runId,
        reason: error instanceof Error ? error.message : String(error),
      });
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
      });
    }
  }

  /** 把 Mastra 的 step 结果拆成时间线事件（文本 / 推理 / 工具调用与结果 / 每步用量） */
  private async persistSteps(
    conversationId: string,
    runId: string,
    steps: StepLike[],
  ): Promise<{ toolCallCount: number }> {
    let toolCallCount = 0;
    for (const [index, step] of steps.entries()) {
      const messageId = `msg_${runId}_${index}`;
      const items: Array<Record<string, unknown>> = [];

      // 推理（只审计；组装上下文时不回灌，见 ContextService）
      const reasoning = this.joinReasoning(step);
      if (reasoning) {
        items.push({
          role: TimelineRole.Assistant,
          kind: TimelineKind.Reasoning,
          messageId,
          payload: { text: reasoning },
        });
      }
      if (step.text) {
        items.push({
          role: TimelineRole.Assistant,
          kind: TimelineKind.Text,
          messageId,
          payload: { text: step.text },
        });
      }
      for (const call of step.toolCalls ?? []) {
        const payload = call.payload ?? {};
        toolCallCount += 1;
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
        });
      }
      for (const toolResult of step.toolResults ?? []) {
        const payload = toolResult.payload ?? {};
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
        });
        // 规划能力：write-plan 的输出额外落一条 `plan` 事件 —— **当前计划 = 最后一条 plan 事件**，
        // 且"什么时候把哪一步标成完成"成为可复盘的历史
        const plan = toPlanPayload(payload.toolName ?? null, payload.result);
        if (plan) {
          items.push({
            role: TimelineRole.Assistant,
            kind: TimelineKind.Plan,
            messageId,
            payload: plan as unknown as Record<string, unknown>,
          });
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
      });

      const finishedAt = new Date();
      await this.timelines.appendMany(
        items.map((item) => ({
          conversationId,
          runId,
          messageId,
          startedAt: finishedAt,
          finishedAt,
          ...item,
        })) as never,
      );
    }
    return { toolCallCount };
  }

  /** 汇总一步里的推理增量文本 */
  private joinReasoning(step: StepLike): string {
    const chunks = step.reasoning ?? [];
    return chunks
      .map((chunk) => {
        const text = chunk.payload?.text;
        return typeof text === 'string' ? text : '';
      })
      .join('')
      .trim();
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
    isAdmin = false,
  ): Promise<void> {
    const mastra = this.requireMastra();
    const conversation = await this.resolveConversation(userId, input);
    const definition = this.registry.resolve(
      input.agentKey ?? conversation.agentKey,
    );
    const run = await this.startRun(conversation, definition.key, userId);
    const startedAt = Date.now();

    // 本轮模型：**只能来自库里的配置**（解析失败直接抛，连流都不建）
    const model = await this.resolveRuntimeModel(definition, input.modelId);
    const modelInstance = await this.resolveModelInstance(model);

    let built = await this.buildContext(
      conversation.id,
      definition,
      input.message,
      model,
      input.attachments,
    );
    if (built.needsCompaction && built.compactionRange) {
      // 注意：这一步在建流之前，**此时还没有中止控制器**（`abort` 后面才声明）→ 信封不带 abortSignal
      await this.summarize(
        conversation.id,
        run.id,
        definition,
        built.compactionRange,
        await this.buildRuntimeContext(
          conversation.id,
          run.id,
          definition,
          userId,
          model,
          {
            isAdmin,
          },
        ),
      );
      built = await this.buildContext(
        conversation.id,
        definition,
        input.message,
        model,
        input.attachments,
      );
    }

    const now = new Date();
    await this.timelines.append({
      conversationId: conversation.id,
      runId: run.id,
      role: TimelineRole.User,
      kind: TimelineKind.Text,
      payload: userMessagePayload(input),
      startedAt: now,
      finishedAt: now,
    });

    const streamId = `${run.id}-${Date.now()}`;
    const abort = new AbortController();
    this.activeRuns.set(run.id, abort);
    await this.runs.setActiveStream(run.id, streamId);
    await this.streamStore.startRun(run.id, {
      status: RunStatus.Running,
      stage: 'generating',
      streamId,
      offset: 0,
      step: 0,
    });

    const recorder = new StreamRecorder(
      this.timelines,
      { conversationId: conversation.id, runId: run.id },
      {
        metas: this.toolMetas,
        isKnownTool: (toolKey) => Boolean(this.toolRegistry.get(toolKey)),
      },
    );
    let offset = 0;
    let stepCount = 0;
    let lastProgressAt = 0;

    // 心跳：SSE 注释帧。间隔必须显著小于网关空闲超时（默认 15s < keepAliveTimeout 75s），
    // 否则"AI 想得久一点就断流"。自己写而不用 `withSseHeartbeat`：后者收的是 Web Response。
    const heartbeat = setInterval(() => {
      if (!response.writableEnded) response.write(': ping\n\n');
    }, STREAM_HEARTBEAT_MS);

    // 跨副本停止：订阅本 run 的停止频道（请求落在别的副本时也停得掉）
    let unsubscribeStop: (() => Promise<void>) | null = null;
    try {
      unsubscribeStop = await this.streamStore.subscribeRun(
        run.id,
        () => undefined,
        () => abort.abort(),
      );
    } catch (error) {
      this.logger.warn('ai.stream.stop_subscribe_failed', {
        runId: run.id,
        reason: error instanceof Error ? error.message : String(error),
      });
    }

    try {
      const requestContext = await this.buildRuntimeContext(
        conversation.id,
        run.id,
        definition,
        userId,
        model,
        // 中止信号（用户停止要停整棵树）+ 渲染后的系统指令（首轮末尾带运行环境）
        {
          abortSignal: abort.signal,
          systemPrompt: await this.resolveSystemPrompt(
            conversation,
            run.id,
            definition,
          ),
        },
      );
      const agent = mastra.getAgent(definition.key);
      const output = await agent.stream(built.messages as never, {
        maxSteps: AGENT_MAX_STEPS,
        abortSignal: abort.signal,
        requestContext,
        // 显式传模型实例：不依赖 Agent 上的动态 model（Mastra 自解析配置那一层曾丢过多模态，见 resolveModelInstance）
        model: modelInstance as never,
        /**
         * **双方共用一个引擎 runId**：Mastra 的 durable 快照按这个 id 落库，
         * 而我们的存储适配层用 `engine_run_id` 找宿主行 —— id 对不上就丢快照（见 `startRun`）。
         */
        runId: run.engineRunId,
      });
      // 子 agent 的实时明细**不走** Mastra 的静态子 agent 通道（我们没有静态子 agent）：
      // 由 `run-sub-agent` 工具经 `context.writer` 写成 `data-sub-agent*` 块进这条流，见 §3.14.5
      const uiStream = toUiStream(output);

      const recorded = (
        uiStream as unknown as ReadableStream<UiChunkLike>
      ).pipeThrough(
        new TransformStream<UiChunkLike, UiChunkLike>({
          transform: async (chunk, controller) => {
            // 先给客户端，再落库：用户的体感不该被落库拖慢
            controller.enqueue(chunk);
            try {
              await recorder.consume(chunk);
              offset = await this.streamStore.appendChunk(run.id, chunk);
              await this.streamStore.publishChunk(run.id, chunk);
              if (chunk.type === 'start-step') stepCount += 1;
              const nowMs = Date.now();
              if (nowMs - lastProgressAt >= STREAM_PROGRESS_THROTTLE_MS) {
                lastProgressAt = nowMs;
                await this.streamStore.patchRun(run.id, {
                  stage:
                    chunk.type === 'tool-input-available'
                      ? `tool:${chunk.toolName ?? ''}`
                      : 'generating',
                  offset,
                  step: stepCount,
                  heartbeatAt: new Date().toISOString(),
                });
                await this.runs.touchHeartbeat(run.id);
              }
            } catch (error) {
              // 录制失败不掐断用户正在看的流：记日志继续（真相仍在，稍后可补）
              this.logger.warn('ai.stream.record_failed', {
                runId: run.id,
                reason: error instanceof Error ? error.message : String(error),
              });
            }
          },
        }),
      );

      // 手写流而不是用 `pipeUIMessageStreamToResponse`：要自己控制"什么时候结束响应"——
      // **收尾（终态 / 消耗 / 统计）落库之后才发 `[DONE]`**，于是客户端看到 `[DONE]`
      // 就代表服务端已经落好终态（否则会出现"收到 [DONE] 但查运行还是 running"的窗口）。
      response.writeHead(200, UI_STREAM_HEADERS);
      response.flushHeaders?.();

      // 先把"这一轮的身份"发给客户端：**前端要靠它记住 runId**（停止与断线重连都只认 runId）。
      // 它走与业务片段**同一条记录 + 广播通道**，所以补发连接也一定会先拿到它。
      const runHead = {
        type: 'data-run',
        data: {
          runId: run.id,
          conversationId: conversation.id,
          agentKey: definition.key,
        },
      };
      if (!response.writableEnded) response.write(sseFrame(runHead));
      offset = await this.streamStore.appendChunk(run.id, runHead);
      await this.streamStore.publishChunk(run.id, runHead);

      const reader = recorded.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (response.writableEnded) break;
        response.write(sseFrame(value));
      }

      // 被中止时 Mastra 会**正常返回**（流被截断但不抛错）→ 必须自己判定"这不是成功，是取消"
      if (abort.signal.aborted) {
        await recorder.flushPending();
        throw new Error('stream_aborted_by_user');
      }
      // 收尾前把没有 text-end 的残余内容也落库（防御性：正常结束一般不会有）
      await recorder.flushPending();

      // 收尾：**先 Postgres 终态，再清 Redis 进度**（反过来会留下"没进度也没结果"的窗口）
      // 步骤 / 用量一律走 stream-result 的读取口径：`agent.stream()` 在**可恢复执行（durable）**下
      // 返回的是包装对象（`{ output, fullStream, … }`），真正的 `MastraModelOutput` 在 `output` 里 ——
      // 直接读 `output.steps` 会拿到 undefined（踩过的崩点，见 stream-result.ts 的注释）
      const steps = (await readStreamSteps(output)) as unknown as StepLike[];
      const persisted = await recorder.finish(steps);
      // 首轮命名：与 agent 上下文完全隔离的一次小调用（失败不影响这一轮，见 title.service.ts）
      const title = await this.generateFirstTurnTitle(
        conversation,
        run.id,
        input.message,
        model,
      );
      const usageBase = await this.rollUpUsage(
        run.id,
        toUsageRecord(await readStreamUsage(output)),
      );
      // 并账要**保留 usageBase 里的非 token 字段**（如 `subAgents`）：
      // `mergeUsage` 只逐字段加 token，直接把它的结果当 usage 会把那些字段抹掉（踩过：子 agent 明细消失）
      const usage = title?.usage
        ? { ...usageBase, ...(mergeUsage(usageBase, title.usage) ?? {}) }
        : usageBase;
      const durationMs = Date.now() - startedAt;
      await this.runs.finish(run.id, {
        status: RunStatus.Succeeded,
        usage,
        stepCount: steps.length,
        toolCallCount: persisted.toolCallCount,
        durationMs,
      });
      await this.runs.setActiveStream(run.id, null);
      await this.runs.saveRequestSnapshot(run.id, {
        model: model.modelRef,
        agentKey: definition.key,
        toolKeys: [...definition.tools],
        skillKeys: [...definition.skills],
        params: { maxSteps: AGENT_MAX_STEPS },
        context: built.snapshot,
      });
      await this.conversationRepo.accumulate(
        conversation.id,
        totalTokensOf(usage),
      );
      await this.applyTitle(conversation, input.message, title);

      /**
       * 标题变更**实时下发**（`data-conversation-title`）。
       *
       * 自动命名发生在收尾阶段，前端那份"会话列表 / 会话详情"缓存不会自己知道 ——
       * 不推的话侧栏与页头要等下一次刷新或切会话才显示新名字（用户反馈：重命名没有实时响应）。
       * 与 `data-run-usage` 同一手法：先给客户端，再进 Redis 记录 + 广播，于是断线补发也拿得到。
       * 只在下发时**确实改过名字**（`title` 非空）时才发；名字没变时前端本来就有正确的值。
       */
      if (title?.title) {
        const titleChunk = {
          type: 'data-conversation-title',
          data: {
            runId: run.id,
            conversationId: conversation.id,
            title: title.title,
          },
        };
        if (!response.writableEnded) response.write(sseFrame(titleChunk));
        offset = await this.streamStore.appendChunk(run.id, titleChunk);
        await this.streamStore.publishChunk(run.id, titleChunk);
      }

      this.logger.log('ai.stream.succeeded', {
        conversationId: conversation.id,
        runId: run.id,
        stepCount: steps.length,
        toolCallCount: persisted.toolCallCount,
        durationMs,
      });

      /**
       * **本轮用量**下发（`data-run-usage`，**不带 id**：一块一个）。
       *
       * 为什么走流而不是让前端再查一次：用量只有收尾时才知道，而"收尾已落库"与"[DONE]"之间
       * 是唯一能保证"客户端看到用量时，库里也一定有了"的位置；同时进 Redis 记录与广播，
       * 于是**断线重连补发**也拿得到（否则刷新后这一段就丢了）。
       *
       * 字段刻意保留 `null` 语义（provider 没上报就是 null，不编造 0）：前端据此显示"—"。
       */
      const usageChunk = {
        type: 'data-run-usage',
        data: {
          runId: run.id,
          usage,
          stepCount: steps.length,
          toolCallCount: persisted.toolCallCount,
          durationMs,
        },
      };
      if (!response.writableEnded) response.write(sseFrame(usageChunk));
      offset = await this.streamStore.appendChunk(run.id, usageChunk);
      await this.streamStore.publishChunk(run.id, usageChunk);

      // 终态已落库 → 现在才告诉客户端"这一轮结束"
      if (!response.writableEnded) {
        response.write('data: [DONE]\n\n');
        response.end();
      }
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      const reason = error instanceof Error ? error.message : String(error);
      if (abort.signal.aborted) {
        // 用户主动停止：是 canceled，不是 failed（语义要分清）
        await this.runs.finish(run.id, {
          status: RunStatus.Canceled,
          durationMs,
        });
        await this.timelines.append({
          conversationId: conversation.id,
          runId: run.id,
          role: TimelineRole.System,
          kind: TimelineKind.Status,
          payload: {
            status: RunStatus.Canceled,
            reason: 'user_stopped',
            operator: userId,
          },
          finishedAt: new Date(),
        });
        this.logger.log('ai.stream.canceled', { runId: run.id, durationMs });
      } else {
        // 响应头已发出：不能抛（会把"流里的错误"变成无声失败），错误已随 error chunk 给到客户端
        const mapped = classifyModelError(error);
        await this.runs.finish(run.id, {
          status: RunStatus.Failed,
          // 失败也要把子 agent 已经烧掉的 token 记在账上
          usage: await this.rollUpUsage(run.id, null),
          errorCode: String(
            (mapped as { code?: number }).code ?? AppErrorCodes.AgentFailed,
          ),
          errorStage: RunErrorStage.Model,
          errorMessage: mapped.message,
          errorDetail: { raw: reason },
          durationMs,
        });
        await this.timelines.append({
          conversationId: conversation.id,
          runId: run.id,
          role: TimelineRole.System,
          kind: TimelineKind.Error,
          payload: { message: mapped.message, stage: RunErrorStage.Model },
          finishedAt: new Date(),
        });
        this.logger.error('ai.stream.failed', {
          runId: run.id,
          reason,
          durationMs,
        });
      }
      await this.runs.setActiveStream(run.id, null);
      if (!response.writableEnded) {
        // 失败也要给客户端一个明确收尾（错误本身已随 error chunk 下发）
        response.write('data: [DONE]\n\n');
        response.end();
      }
    } finally {
      clearInterval(heartbeat);
      if (unsubscribeStop) await unsubscribeStop();
      this.activeRuns.delete(run.id);
      // 通知"还在补发中的重连连接"：本轮结束了（同一条流协议里的结束标记）
      try {
        await this.streamStore.publishChunk(run.id, {
          type: STREAM_END_MARKER,
        });
      } catch {
        // 广播失败无碍：补发连接会被客户端的 idle 处理或下一次刷新收敛
      }
      await this.streamStore.clearRun(run.id);
      if (!response.writableEnded) response.end();
    }
  }

  /** 停止某一轮：本进程直接 abort；不在本进程则广播（跨副本） */
  async stopRun(
    userId: string,
    runId: string,
  ): Promise<AgentRunStopResultModel> {
    const run = await this.runs.findEntity(runId);
    if (!run) throw new RunNotFoundError(runId);
    await this.conversations.requireOwned(userId, run.conversationId);

    const controller = this.activeRuns.get(runId);
    if (controller) {
      controller.abort();
      return { stopped: true, injected: 'local' };
    }
    await this.streamStore.publishStop(runId);
    return { stopped: true, injected: 'broadcast' };
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
    const active = await this.runs.findActiveByUser(userId);
    if (!active) return false;
    return this.resumeRun(userId, active.id, offset, response);
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
    const run = await this.runs.findEntity(runId);
    if (!run) throw new RunNotFoundError(runId);
    await this.conversations.requireOwned(userId, run.conversationId);

    const progress = await this.streamStore.readRun(runId);
    if (!progress || progress.status !== RunStatus.Running) return false;

    response.writeHead(200, UI_STREAM_HEADERS);
    response.flushHeaders?.();

    const backlog = (await this.streamStore.readChunks(
      runId,
      offset,
    )) as UiChunkLike[];

    /**
     * **补发的第一块必须是 `start`**（消息身份所在的那块）。
     *
     * AI SDK 的 `useChat({ resume: true })` 在补发时先按自己的规则生成一个消息 id，
     * 收到带 `messageId` 的 `start` 块才把它换成正主；而"第一块"就会触发一次写消息 ——
     * 如果第一块不是 `start`，它会先在列表里**新 push 一条**空消息（正主随后写进去），
     * 于是刷新后同一个回答在界面上出现两份（还会互相覆盖着长，看起来像"没重连"）。
     *
     * 我们为了让前端尽早拿到 runId，`data-run` 是写在 `start` 之前的（实时流这样没问题，
     * 因为那时列表里还没有同 id 的消息）—— 所以**补发时把 `start` 挪到最前面**。
     */
    const startIndex = backlog.findIndex((chunk) => chunk?.type === 'start');
    const ordered =
      startIndex > 0
        ? [
            backlog[startIndex],
            ...backlog.slice(0, startIndex),
            ...backlog.slice(startIndex + 1),
          ]
        : backlog;

    let ended = false;
    for (const chunk of ordered) {
      if (chunk?.type === STREAM_END_MARKER) {
        ended = true;
        break;
      }
      if (!response.writableEnded) response.write(sseFrame(chunk));
    }
    if (ended) {
      if (!response.writableEnded) response.end();
      return true;
    }

    // 挂住连接，转发实时片段直到客户端断开或本轮结束
    await new Promise<void>((resolve) => {
      let unsubscribe: (() => Promise<void>) | null = null;
      const finish = (): void => {
        void unsubscribe?.();
        resolve();
      };
      response.on('close', finish);
      void this.streamStore
        .subscribeRun(
          runId,
          (chunk) => {
            const typed = chunk as UiChunkLike;
            if (typed?.type === STREAM_END_MARKER) {
              finish();
              return;
            }
            if (!response.writableEnded) response.write(sseFrame(chunk));
          },
          () => undefined,
        )
        .then((fn) => {
          unsubscribe = fn;
        })
        .catch(() => finish());
    });
    if (!response.writableEnded) response.end();
    return true;
  }

  /**
   * 组装并放入**运行时信封**（`requestContext`）。
   *
   * 为什么由编排层算：`run-sub-agent` 工具需要"子 agent 能用哪些工具"，
   * 而这依赖注册机；若让工具自己注入注册机，装配会成环
   * （注册机依赖工具）。信封把这份依赖倒过来，见设计文档 §3.14.4。
   *
   * `systemPrompt` 是**渲染后的系统指令全文**（见 {@link resolveSystemPrompt}）；不传则用装配期的基础指令。
   */
  private async buildRuntimeContext(
    conversationId: string,
    parentRunId: string,
    definition: AgentDefinition,
    userId: string,
    model: RuntimeModel,
    options: {
      abortSignal?: AbortSignal;
      systemPrompt?: string;
      isAdmin?: boolean;
    } = {},
  ): Promise<RequestContext> {
    const envelope: AgentRuntimeEnvelope = {
      conversationId,
      parentRunId,
      triggeredBy: userId,
      // 身份由编排层给（控制器从鉴权上下文取）：工具作用域判定用它，**不由模型决定**
      isAdmin: options.isAdmin ?? false,
      depth: 0,
      agentKey: definition.key,
      // 根 agent key：子 agent 沿用父的判定（作用域按它算）
      rootAgentKey: definition.key,
      model,
      // 子 agent 的工具面 = 全部 − 委派类 − child:deny（于是它不能再造子 agent，深度天然为 1）
      childToolbox: this.toolRegistry.childToolbox(),
      skills: await this.skillLoader.resolve(definition.skills),
      ...(options.systemPrompt ? { systemPrompt: options.systemPrompt } : {}),
      ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
    };
    // 与 `RequestContext` 的读写收在适配器里（主体不认识 Mastra 的这个词）
    return toRequestContext(envelope);
  }

  /**
   * 会话**开局**的运行环境片段（操作系统 + 当前时间）；非首轮返回 `undefined`。
   *
   * 「首轮」= 这个会话还没有完成过任何一轮（`turnCount === 0`）。两个刻意的取舍：
   * 1. **只在首轮注入**：系统提示词是请求前缀，每轮塞一个新时间戳会让提供方的前缀缓存
   *    每轮失效（本工程专门统计缓存命中，不能自己把它打掉）；需要精确时间时模型用
   *    `run-command` 自己取。中途某一轮失败重试仍是 `turnCount === 0`，环境会重新注入 —— 无妨。
   * 2. **渲染失败不打断问答**：环境片段是"锦上添花"，模板出问题记一条 warn 继续跑，
   *    不让一轮已经付过钱的问答因为一段附加文本而失败。
   */
  /**
   * 本轮**真正送进模型的系统指令全文**：基础指令 +（仅首轮的）运行环境，并**落一条快照**。
   *
   * 为什么要把这份文本存库（用户要求）：
   * - 前端「查看系统指令」要看的是**这个会话实际用过的**那份 —— 它随会话而变（首轮末尾有环境片段，
   *   之后没有），静态定义答不了这个问题；
   * - 审计回看时，"当时模型被怎么要求"是可查的事实，而不是"现在模板长什么样"的猜测。
   *
   * **口径（用户拍板）：每个会话首轮生成一次**。
   *
   * 实现方式：先读这个会话已有的快照 —— **同一个 agent 就直接逐字复用**（不重算）。
   * 于是"会话进行中改了提示词模板 / 调了工具面"都不会让这个会话中途换系统提示词：
   * 前缀缓存不被打断（本工程专门统计缓存命中），审计回看也确定。
   *
   * 唯一的例外是**显式换 agent**（会话里那个 agent 选择器）：那时按新 agent 重新生成并落一条新快照 ——
   * 不重生成的话，用户切了 agent 却还在用旧提示词，属于把功能做哑了。
   * 老快照没有 `agentKey`（该字段是后加的）时同样走重生成，只会多落一条、不会丢信息。
   */
  private async resolveSystemPrompt(
    conversation: ConversationEntity,
    runId: string,
    definition: AgentDefinition,
  ): Promise<string> {
    // ★ 首轮生成一次：同一个 agent 的后续轮次**逐字复用**首轮那份（不是"重算后比对"）
    const previous = await this.timelines.latestSystemPrompt(conversation.id);
    if (previous && previous.agentKey === definition.key) return previous.text;

    const environment = this.renderEnvironment(conversation);
    const systemPrompt = environment
      ? `${definition.instructions}\n\n${environment}`
      : definition.instructions;

    await this.timelines.append({
      conversationId: conversation.id,
      runId,
      role: TimelineRole.System,
      kind: TimelineKind.System,
      payload: {
        text: systemPrompt,
        agentKey: definition.key,
        // 便于一眼看出这条快照是哪种形态（首轮那条为 true）
        environmentInjected: Boolean(environment),
      },
      finishedAt: new Date(),
    });
    return systemPrompt;
  }

  private renderEnvironment(
    conversation: ConversationEntity,
  ): string | undefined {
    if (conversation.turnCount > 0) return undefined;
    try {
      return this.prompts.renderPartial(
        'partials/environment',
        buildEnvironmentData(),
      );
    } catch (error) {
      this.logger.warn('ai.environment.render_failed', {
        conversationId: conversation.id,
        reason: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
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
    const children = await this.runs.listChildUsages(runId);
    if (children.length === 0) return own;
    const subAgents = mergeUsage(...children);
    return { ...(own ?? {}), subAgents, ...(mergeUsage(own, subAgents) ?? {}) };
  }

  private requireMastra(): Mastra {
    if (!this.mastra) throw new AgentUnavailableError();
    return this.mastra;
  }
}

/** Mastra step 结果的最小结构（只取我们要落库的字段，避免把它的内部类型铺满本文件） */
interface StepLike {
  text?: string;
  reasoning?: Array<{ payload?: { text?: string } }>;
  toolCalls?: Array<{
    payload?: { toolCallId?: string; toolName?: string; args?: unknown };
  }>;
  toolResults?: Array<{
    payload?: {
      toolCallId?: string;
      toolName?: string;
      result?: unknown;
      isError?: boolean;
    };
  }>;
  usage?: unknown;
  finishReason?: string;
}

/** 时间线事件（仅用于类型收口） */
export type { TimelineEntity };

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
export const STREAM_HEARTBEAT_MS = 15_000;
export const STREAM_PROGRESS_THROTTLE_MS = 1_000;

/** 流式片段的最小结构（录制器与转发共用） */
interface UiChunkLike {
  type?: string;
  toolName?: string;
  messageId?: string;
}

/** Express Response 的最小接口（只在编排层用，避免把 express 类型铺进来） */
export interface StreamResponseLike {
  writeHead: (status: number, headers: Record<string, string>) => unknown;
  flushHeaders?: () => void;
  write: (chunk: string) => unknown;
  end: () => unknown;
  status?: (code: number) => { end: () => unknown };
  writableEnded?: boolean;
  on: (event: string, handler: () => void) => unknown;
}

/** 输出记录里的"本轮结束"标记（补发连接见到它就收尾） */
export const STREAM_END_MARKER = '__run_end__';

const UI_STREAM_HEADERS: Record<string, string> = {
  'content-type': 'text/event-stream',
  'cache-control': 'no-cache',
  connection: 'keep-alive',
  // 协议自描述（官方客户端不校验，但自建后端写上便于排查）与关掉网关缓冲
  'x-vercel-ai-ui-message-stream': 'v1',
  'x-accel-buffering': 'no',
};

const sseFrame = (chunk: unknown): string =>
  `data: ${JSON.stringify(chunk)}\n\n`;
