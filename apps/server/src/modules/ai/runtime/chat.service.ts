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
  type AgentChatResumeDto,
  type AgentChatResultModel,
  type AgentRunStopResultModel,
  type ChatAttachmentModel,
} from '@repo/shared';
import type { Mastra } from '@mastra/core/mastra';
import { RequestContext } from '@mastra/core/request-context';
import { AGENT_MAX_STEPS, AGENT_TOOL_CONCURRENCY } from '../core/constants.js';
import {
  AgentConfig,
  type AgentConfig as AgentConfigValue,
} from '../core/config.js';
import {
  AgentFailedError,
  AgentUnavailableError,
  ConversationBusyError,
  ModelNoResponseError,
  ProviderAuthFailedError,
  ProviderRateLimitedError,
  RunNotFoundError,
  RunNotSuspendedError,
} from '../core/errors.js';
import { AGENT_REGISTRY } from '../agents/registry.js';
import { MASTRA } from '../mastra/ai.mastra.js'
import { agentMemory as sharedAgentMemory } from '../mastra/agent-memory.js';
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
import { StreamRecorder, toolFailureOf } from './stream-recorder.js';
import { fitMessagesToToolBudget } from './turn-budget.js';
import { readStreamSteps, readStreamUsage } from './stream-result.js';
import { resumeSafeChunks } from './stream-resume.js';
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

/** 兜底会话名：首条消息里没有可用文字时用它，**不拿 URL 当名字** */
const DEFAULT_CONVERSATION_TITLE = '新对话';

/**
 * 这条消息能不能直接拿来当标题。
 *
 * 为什么不能直接用：首条消息经常只贴了一个链接（"帮我看看这个"），截 40 字得到的
 * 是一串 `https://…` 或裸域名 —— 侧栏里两行都一样，谁也认不出是哪次对话。
 * 判据刻意保守：只拒绝"整体就是一个链接 / 域名 / 纯符号"的消息，正常中文开头的一句
 * 带链接的话仍然照常截断（那句话本身有信息量）。
 */
const looksLikeUrlOnly = (text: string): boolean => {
  const compact = text.trim();
  if (!compact) return true;
  if (/^https?:\/\/\S+$/i.test(compact)) return true;
  if (/^www\.\S+$/i.test(compact)) return true;
  // 裸域名（例如 example.com/path）：要求整串只有域名与路径，不含空格
  if (/^[\w-]+(\.[\w-]+)+(\/\S*)?(\?\S*)?$/i.test(compact)) return true;
  // 纯标点 / 纯符号
  return !/[\p{L}\p{N}]/u.test(compact);
};

/** 用首条用户消息生成会话标题（不额外调模型，省钱）；没有可用文字时给默认名 */
const titleFrom = (message: string): string => {
  const text = message.replace(/\s+/g, ' ').trim();
  if (looksLikeUrlOnly(text)) return DEFAULT_CONVERSATION_TITLE;
  return text.slice(0, 40);
};

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

  /** 主 agent 的对话记忆（与 createMastra 共用同一个单例） */
  private readonly agentMemory = sharedAgentMemory;

  private async ensureAgentThread(
    conversationId: string,
    userId: string,
  ): Promise<{ thread: string; resource: string }> {
    const existing = await this.agentMemory.getThreadById({ threadId: conversationId });
    if (!existing) {
      await this.agentMemory.createThread({
        threadId: conversationId,
        resourceId: userId,
        title: conversationId,
      });
    }
    return { thread: conversationId, resource: userId };
  }

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

  /**
   * 失败 / 超时的一轮也要把兜底标题落下去。
   *
   * 标题原本只在**成功收尾**时写；首轮失败（模型超时、上下文过长）就留一条空白会话，
   * 侧栏里认不出来。这里只补"还没有标题"的会话，用户改过的名不动；失败也不影响原错误上抛。
   */
  private async ensureFallbackTitle(
    conversation: ConversationEntity,
    message: string,
  ): Promise<void> {
    if (conversation.title) return;
    try {
      await this.applyTitle(conversation, message, null);
    } catch (error) {
      this.logger.warn('ai.conversation.title_fallback_failed', {
        conversationId: conversation.id,
        reason: error instanceof Error ? error.message : String(error),
      });
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

    // 心跳：**非流式路径也必须续租**，理由与流式那处逐字相同（见 `chatStream` 里的长注释）——
    // 看门狗判的是「还有没有人在管这一轮」（进程活着 = 有人管），不是「有没有产出」。
    // 这条路径上唯一的长 await 就是 `agent.generate()`：工具往返全在里面，模型思考期间不产任何东西，
    // 不续租就会被判成 3310 超时。而这里没有 SSE 兜着（离线脚本 / CLI / 服务端自调用都走
    // `POST /agent/chat`），一旦判了就是「进程还在跑、库里已标 failed」两份互相矛盾的真相。
    const heartbeat = setInterval(() => {
      void this.runs.touchHeartbeat(run.id).catch(() => undefined)
    }, STREAM_HEARTBEAT_MS)
    heartbeat.unref?.()

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

      // ② 输入快照**在调模型之前就落库**：失败 / 超时 / 进程被杀的运行也要查得到"给了模型什么"
      //    （以前只在成功收尾时写，于是"失败的那一轮"在审计里没有输入侧证据）
      await this.runs.saveRequestSnapshot(run.id, {
        model: model.modelRef,
        agentKey: definition.key,
        toolKeys: this.toolRegistry.expand(definition.tools),
        // 技能名现算：`skills: ['*']` 在运行期展开，在线新建的技能这一轮就能出现在快照里
        skillKeys: (await this.skillLoader.resolve(definition.skills)).map((skill) => skill.name),
        params: { maxSteps: AGENT_MAX_STEPS },
        context: built.snapshot,
      });

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
          // 身份要进运行时信封：admin 作用域的工具（skill-*）按它过滤工具面。
          // 漏传的后果是模型手上根本没有这些工具，只能绕去 run-command 写盘（2026-11-11 实际踩过）。
          isAdmin,
        },
      );
      const agent = mastra.getAgent(definition.key);
      const result = await agent.generate(built.messages as never, {
        maxSteps: AGENT_MAX_STEPS,
        // 工具调用并发策略：只有真的调用了挂起类工具的那一步串行，其余按并发跑
        // （子 agent 的并行由此打开；同时跑几个由 AgentRunner 的闸门管，见 constants.ts）
        toolCallConcurrency: AGENT_TOOL_CONCURRENCY,
        requestContext,
        // 显式传模型实例：不依赖 Agent 上的动态 model（Mastra 自解析配置那一层曾丢过多模态，见 resolveModelInstance）
        model: modelInstance as never,
        // 与流式同一口径：引擎 runId 由我们定、并回写到 `runs.engine_run_id`（durable 快照靠它认亲）
        runId: run.engineRunId,
        // 轮内预算：每一步前把工具结果的累计体积压回窗口预算内
        prepareStep: this.buildPrepareStep(built.snapshot.windowTokens),
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

      clearInterval(heartbeat);
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
      // 失败的一轮也要有会话名（否则首轮失败就留一条空白会话）
      await this.ensureFallbackTitle(conversation, input.message);
      clearInterval(heartbeat);
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
   * `prepareStep`：**每一步**开始前把工具结果的累计体积压回预算内（细节见 `turn-budget.ts`）。
   *
   * 为什么是"每步"而不是"轮前"：一轮里的工具往返是上下文暴涨的真正来源，
   * 而轮前压缩只在开头判定一次；等这一轮结束再压，钱已经烧掉了。
   * 只改"给模型的视图"，时间线里的出参仍由录制器全量落库。
   */
  private buildPrepareStep(windowTokens: number) {
    const budgetChars = Math.max(
      256,
      Math.floor(windowTokens * this.config.contextToolResultTotalRatio * 2),
    );
    return (args: { messages?: unknown }) => {
      const result = fitMessagesToToolBudget(args?.messages, { budgetChars });
      if (result.trimmedCount === 0) return undefined;
      this.logger.warn('ai.context.turn_trim', {
        budgetChars,
        trimmedCount: result.trimmedCount,
        beforeChars: result.beforeChars,
        afterChars: result.afterChars,
      });
      // Mastra 的 payload 类型是 MastraDBMessage[]；我们只按结构压结果，不改别的字段
      return { messages: result.messages as never };
    };
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
   *
   * ## 终态保证（2026-10-18 修）
   *
   * `startRun` 之后的一切都在这一个 `try` 里：**解析模型、组装上下文、读附件、落用户消息、
   * 建 Redis 进度**这些「建流之前」的步骤同样可能失败（3406 没配模型 / 3311 附件读不回来 /
   * 3407 会话不合法…）。早先它们写在 `try` 外面，一失败就**只留下一条 `running` 的运行记录**：
   * 前端看不到任何错误，下一次发消息还会被部分唯一索引挡成 3306「该会话已有进行中的对话」，
   * 直到看门狗 60 秒后把它判超时。现在任何一步失败都会落终态（并写一条 `error` 时间线），
   * 会话立刻可以重试；**如果流还没建（响应头未发），错误原样抛回 HTTP 层**，
   * 前端 `onError` 能看到 3406 / 3311 这种具体原因，而不是一个空回答。
   *
   * ## 心跳为什么先续租、再写 ping（2026-10-18 修）
   *
   * 心跳回调里 `response.write(': ping')` 在客户端断开 / 响应已结束时**会抛
   * 「Connection is closed.」** —— 这是定时器里的异常，进程级 `uncaughtException` 会直接
   * `process.exit(1)`：表现为「聊着聊着服务重启了、正在跑的几轮全丢、再发消息 3306」。
   * 所以顺序改成**先 `touchHeartbeat`（保租约），再 best-effort 写 ping**；
   * 写失败只丢这一帧 SSE 注释，不影响运行，也不会把进程带走。
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

    // 本进程内中止控制器：**在建流之前就登记**，否则"解析模型时用户点停止"找不到目标
    const abort = new AbortController();
    this.activeRuns.set(run.id, abort);

    let heartbeat: NodeJS.Timeout | undefined;
    let unsubscribeStop: (() => Promise<void>) | null = null;
    /** 响应头是否已经发出（决定失败时是「抛回 HTTP」还是「按 SSE 收尾」） */
    let streamStarted = false;
    /**
     * 首 token 看护：从发起模型调用到**第一段输出**之间没有任何动静就中止。
     *
     * 单独一个标记而不是直接看 `abort.signal.aborted`：那个信号也用于"用户点停止"，
     * 两者语义不同（一个是 3314 失败，一个是 canceled），必须在收尾时分得清。
     */
    let firstTokenTimer: NodeJS.Timeout | undefined;
    let firstTokenTimedOut = false;
    let firstTokenSeen = false;

    const stopFirstTokenTimer = (): void => {
      if (!firstTokenTimer) return;
      clearTimeout(firstTokenTimer);
      firstTokenTimer = undefined;
    };
    /** 收到第一段输出（文本 / 推理 / 工具入参）就撤掉看护 */
    const markFirstTokenSeen = (): void => {
      if (firstTokenSeen) return;
      firstTokenSeen = true;
      stopFirstTokenTimer();
    };
    const armFirstTokenTimer = (): void => {
      const timeoutMs = this.config.firstTokenTimeoutMs;
      if (!timeoutMs || firstTokenTimer) return;
      firstTokenTimer = setTimeout(() => {
        firstTokenTimedOut = true;
        // 走同一个 abort：Mastra 收流后会正常返回，收尾分支按"超时失败"处理
        abort.abort();
      }, timeoutMs);
      firstTokenTimer.unref?.();
    };

    const stopHeartbeat = (): void => {
      if (!heartbeat) return;
      clearInterval(heartbeat);
      heartbeat = undefined;
    };

    /**
     * 起心跳：SSE 注释帧（保连接）+ **DB 租约**（保这一轮不被看门狗误杀）。
     *
     * 间隔必须显著小于网关空闲超时（默认 15s < keepAliveTimeout 75s），否则"AI 想得久一点就断流"。
     * 模型在**吐出第一个 token 之前**可能安静很久（长上下文 + 推理型模型），
     * 所以从建流前就开始续租 —— 看门狗判的是「还有没有人在管这一轮」，不是「有没有产出」。
     */
    const ensureHeartbeat = (): void => {
      if (heartbeat) return;
      heartbeat = setInterval(() => {
        // ① 先续租：即使客户端已经断开，这一轮仍然有人在管（生成还在继续，可重连续看）
        void this.runs.touchHeartbeat(run.id).catch(() => undefined);
        // ② 再 best-effort 写注释帧：写失败只说明连接没了，不能把进程带走。
        //    必须等 `writeHead` 之后才写 —— 在响应头之前写会隐式发出 200 + 默认响应头，
        //    随后 `writeHead(200, SSE_HEADERS)` 会抛 ERR_HTTP_HEADERS_SENT（长握手 + 15s 心跳就会踩到）。
        if (streamStarted) writeSse(response, ': ping\n\n');
      }, STREAM_HEARTBEAT_MS);
      heartbeat.unref?.();
    };

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
        // 注意：压缩发生在建流之前（尚未 writeHead），它的模型调用不单独接 abortSignal ——
        // 失败会降级为纯裁剪（见 summarize），不会阻断这一轮
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

      // ③ 输入快照**在调模型之前就落库**（失败 / 超时 / 进程被杀的运行也要查得到输入侧证据）
      await this.runs.saveRequestSnapshot(run.id, {
        model: model.modelRef,
        agentKey: definition.key,
        toolKeys: this.toolRegistry.expand(definition.tools),
        // 技能名现算：`skills: ['*']` 在运行期展开，在线新建的技能这一轮就能出现在快照里
        skillKeys: (await this.skillLoader.resolve(definition.skills)).map((skill) => skill.name),
        params: { maxSteps: AGENT_MAX_STEPS },
        context: built.snapshot,
      });

      // ③ 用户消息先落库（之后无论成败，审计上都能看到"用户问了什么"）
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

      // ④ 建流：进度 / 录制器 / 心跳 / 跨副本停止
      const streamId = `${run.id}-${Date.now()}`;
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
      /** 这一轮流里是否出现了工具挂起（`ask-user-questions`） */
      let suspended = false;

      ensureHeartbeat();

      // 跨副本停止：订阅本 run 的停止频道（请求落在别的副本时也停得掉）
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
          // 同上：工具面按身份过滤，admin 的 skill-* 工具要靠这个字段才出现
          isAdmin,
        },
      );
      const agent = mastra.getAgent(definition.key);
      const memoryThread = await this.ensureAgentThread(conversation.id, userId);
      // 模型可能"卡住不吐字"：从发起调用开始计时，第一段输出到了就撤（见上方 firstTokenTimer）
      armFirstTokenTimer();
      const output = await agent.stream(built.messages as never, {
        maxSteps: AGENT_MAX_STEPS,
        // 工具调用并发策略：`called` = 只有真的调用了挂起类工具的那一步才串行。
        // 默认的 `available` 会因为工具集里有 ask-user-questions 把**整步**压成串行，
        // 子 agent 于是只能一个一个跑（见 constants.ts 的注释与闸门）
        toolCallConcurrency: AGENT_TOOL_CONCURRENCY,
        abortSignal: abort.signal,
        requestContext,
        memory: memoryThread,
        savePerStep: true,
        // 显式传模型实例：不依赖 Agent 上的动态 model（Mastra 自解析配置那一层曾丢过多模态，见 resolveModelInstance）
        model: modelInstance as never,
        /**
         * **双方共用一个引擎 runId**：Mastra 的 durable 快照按这个 id 落库，
         * 而我们的存储适配层用 `engine_run_id` 找宿主行 —— id 对不上就丢快照（见 `startRun`）。
         */
        runId: run.engineRunId,
        closeOnSuspend: true,
        // 轮内预算：每一步前把工具结果的累计体积压回窗口预算内（与轮前压缩是两层）
        prepareStep: this.buildPrepareStep(built.snapshot.windowTokens),
      });
      // 子 agent 的实时明细**不走** Mastra 的静态子 agent 通道（我们没有静态子 agent）：
      // 由 `run-sub-agent` 工具经 `context.writer` 写成 `data-sub-agent*` 块进这条流，见 §3.14.5
      const uiStream = toUiStream(output);

      const recorded = (
        uiStream as unknown as ReadableStream<UiChunkLike>
      ).pipeThrough(
        new TransformStream<UiChunkLike, UiChunkLike>({
          transform: async (chunk, controller) => {
            // 第一段输出到了：撤掉首 token 看护（文本 / 推理 / 工具入参都算"模型动了"）
            if (
              chunk.type === 'text-delta' ||
              chunk.type === 'reasoning-delta' ||
              chunk.type === 'tool-input-available'
            ) {
              markFirstTokenSeen();
            }
            // 挂起是这一轮的"暂停"，不是成功；收尾分支据此决定 finish 还是 suspend。
            if (chunk.type === 'data-tool-call-suspended') suspended = true;
            const recordedChunk = normalizeSuspendedChunk(chunk, run.id);
            // 客户端看到的那一份：`ok:false` 的结果按失败呈现（录制器仍拿原始片段，出参全量入库）
            const outgoing = toClientToolChunk(recordedChunk);
            // 先给客户端，再落库：用户的体感不该被落库拖慢
            controller.enqueue(outgoing);
            try {
              await recorder.consume(recordedChunk);
              offset = await this.streamStore.appendChunk(run.id, outgoing);
              await this.streamStore.publishChunk(run.id, outgoing);
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
      streamStarted = true;
      // 客户端断开是常态（刷新 / 换网络 / 关标签页）：不要让 socket 的 error 事件
      // 变成进程级未捕获异常（那会 `process.exit(1)`，把其它会话也一起带走）
      response.on?.('error', () => undefined);

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
      writeSse(response, sseFrame(runHead));
      offset = await this.streamStore.appendChunk(run.id, runHead);
      await this.streamStore.publishChunk(run.id, runHead);

      const reader = recorded.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        // 客户端断开后**继续读**：这一轮的内容仍要落库 / 落 Redis，
        // 用户重新接回来（resume）时才能补发 —— 不能因为一次断线就把整轮丢掉。
        writeSse(response, sseFrame(value));
        // 挂起事件到了就主动收流：Mastra 的挂起流不会再自己结束（它在等 resume），
        // 继续 read 会一直挂着，会话永远不释放。cancel 上游，下面按 suspended 收尾。
        if (value.type === 'data-tool-call-suspended') {
          // 不 cancel 上游：挂起后 Mastra 还要把嵌套 workflow 的快照补完整；
          // 直接断读会让 resume 拿到缺了嵌套 step input 的快照。
          break;
        }
      }

      // 被中止时 Mastra 会**正常返回**（流被截断但不抛错）→ 必须自己判定"这不是成功，是取消"
      if (abort.signal.aborted) {
        await recorder.flushPending();
        // 首 token 超时也走 abort，但语义是"失败"不是"用户取消"（收尾分支据此分流）
        throw new Error(firstTokenTimedOut ? 'first_token_timeout' : 'stream_aborted_by_user');
      }
      // 收尾前把没有 text-end 的残余内容也落库（防御性：正常结束一般不会有）
      await recorder.flushPending();

      /**
       * 工具挂起（`ask-user-questions`）：这一轮**没有结束**，只是停在等用户回答。
       *
       * 不能走下面的 `finish(Succeeded)`；否则会话被释放、快照被当成"已完成"，
       * 用户回答时没有可续跑的 run。这里把状态落成 `suspended`，保住 `engine_run_id` 与 Mastra 快照，
       * 回答时走 `/agent/chat/resume` 从同一条 run 继续。
       */
      if (suspended) {
        const suspendSteps = (await readStreamSteps(output)) as unknown as StepLike[];
        const persistedSuspend = await recorder.finish(suspendSteps);
        const suspendUsage = await this.rollUpUsage(
          run.id,
          toUsageRecord(await readStreamUsage(output)),
        );
        await this.runs.suspend(run.id, {
          usage: suspendUsage,
          stepCount: suspendSteps.length,
          toolCallCount: persistedSuspend.toolCallCount,
          durationMs: Date.now() - startedAt,
        });
        await this.runs.setActiveStream(run.id, null);
        stopHeartbeat();
        writeSse(response, sseFrame({
          type: 'data-run-suspended',
          data: { runId: run.id, conversationId: conversation.id },
        }));
        writeSse(response, 'data: [DONE]\n\n');
        endSse(response);
        this.logger.log('ai.stream.suspended', {
          conversationId: conversation.id,
          runId: run.id,
          stepCount: suspendSteps.length,
          toolCallCount: persistedSuspend.toolCallCount,
        });
        return;
      }

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
        // 首 token 耗时（毫秒）：只有流式路径量得到；没有输出过就是 null，不编 0
        firstTokenMs:
          recorder.firstOutputAtMs === null ? null : recorder.firstOutputAtMs - startedAt,
      });
      await this.runs.setActiveStream(run.id, null);
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
        writeSse(response, sseFrame(titleChunk));
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
      writeSse(response, sseFrame(usageChunk));
      offset = await this.streamStore.appendChunk(run.id, usageChunk);
      await this.streamStore.publishChunk(run.id, usageChunk);

      // 终态已落库 → 先停心跳，再告诉客户端"这一轮结束"：
      // 顺序反了会留出"response 已 end、定时器又写一帧"的窗口（正是进程被杀的那个 bug）
      stopHeartbeat();
      writeSse(response, 'data: [DONE]\n\n');
      endSse(response);
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      const reason = error instanceof Error ? error.message : String(error);
      let mapped: Error | null = null;

      // 首 token 超时也调用了 abort，但它是**失败**（3314），不是用户取消（canceled）
      if (firstTokenTimedOut) {
        mapped = new ModelNoResponseError(this.config.firstTokenTimeoutMs);
        await this.runs.finish(run.id, {
          status: RunStatus.Failed,
          usage: await this.rollUpUsage(run.id, null),
          errorCode: String(AppErrorCodes.ModelNoResponse),
          errorStage: RunErrorStage.Model,
          errorMessage: mapped.message,
          errorDetail: { raw: reason, timeoutMs: this.config.firstTokenTimeoutMs },
          durationMs,
        });
        await this.timelines.append({
          conversationId: conversation.id,
          runId: run.id,
          role: TimelineRole.System,
          kind: TimelineKind.Error,
          payload: { message: mapped.message, stage: RunErrorStage.Model, reason: 'first_token_timeout' },
          finishedAt: new Date(),
        });
        this.logger.error('ai.stream.first_token_timeout', {
          runId: run.id,
          timeoutMs: this.config.firstTokenTimeoutMs,
          durationMs,
        });
        // 失败的一轮也要有会话名（否则侧栏是一条空白）
        await this.ensureFallbackTitle(conversation, input.message);
      } else if (abort.signal.aborted) {
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
        mapped = classifyModelError(error);
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
        // 失败的一轮也要有会话名（以前只有成功收尾才落标题 → 失败会话在侧栏是一条空白）
        await this.ensureFallbackTitle(conversation, input.message);
      }

      await this.runs.setActiveStream(run.id, null);

      /**
       * 响应头还没发 → 这一轮**根本没建流**（模型解析 / 附件读取 / 上下文组装失败）。
       * 此时必须把真实错误**抛回 HTTP 层**：控制器会把 3406 / 3311 这类具体错误码
       * 原样返回，前端 `onError` 能显示"去后台配模型"这种可行动的原因。
       * 若在这里吞掉并写一个 `[DONE]`，客户端只会看到"空回答"，而错误码永远传不出去。
       */
      if (!streamStarted) {
        throw mapped ?? error;
      }

      // 失败也要给客户端一个明确收尾（错误本身已随 error chunk 下发）
      writeSse(response, 'data: [DONE]\n\n');
      endSse(response);
    } finally {
      stopHeartbeat();
      stopFirstTokenTimer();
      try {
        if (unsubscribeStop) await unsubscribeStop();
      } catch (error) {
        // 取消订阅失败无碍：那条订阅连接会随进程 / Redis 自然回收
        this.logger.warn('ai.stream.unsubscribe_failed', {
          runId: run.id,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
      this.activeRuns.delete(run.id);
      // 通知"还在补发中的重连连接"：本轮结束了（同一条流协议里的结束标记）
      try {
        await this.streamStore.publishChunk(run.id, {
          type: STREAM_END_MARKER,
        });
      } catch {
        // 广播失败无碍：补发连接会被客户端的 idle 处理或下一次刷新收敛
      }
      try {
        await this.streamStore.clearRun(run.id);
      } catch {
        // Redis 短暂不可用不改变终态：看门狗以 Postgres 的心跳为准
      }
      // 只有"确实建过流"才由这里收尾响应；没建流时留给 HTTP 错误处理器写 JSON 信封
      if (streamStarted) endSse(response);
    }
  }

  /**
   * 回答挂起中的一轮（`POST /agent/chat/resume`）。
   *
   * 与 {@link chatStream} 的关键区别：**不新建业务 run、不把答案写成用户消息、不重建上下文** ——
   * Mastra 已经通过 durable 快照把这一轮的模型消息、工具调用与挂起点存在 `runs.snapshot` 里；
   * 这里先把 `{ answers }` 交给 `agent.resumeStream()` 从工具处恢复，再另起一段新 engine run
   * （同一 memory thread + 一条只给模型看的"用户已回答"消息）把 agentic loop 推到最终回答。
   *
   * 为什么把续跑单独写一个入口：挂起期间用户可能刷新 / 换设备，甚至换一个副本；
   * 续跑请求必须能从库里的 run 重建，不能依赖"原来那个进程里的闭包"。
   */
  async resumeChat(
    userId: string,
    input: AgentChatResumeDto,
    response: StreamResponseLike,
    isAdmin = false,
  ): Promise<void> {
    const mastra = this.requireMastra();
    const run = await this.runs.findEntity(input.runId);
    if (!run) throw new RunNotFoundError(input.runId);
    const conversation = await this.conversations.requireOwned(userId, run.conversationId);
    if (run.status !== RunStatus.Suspended || !run.engineRunId) {
      throw new RunNotSuspendedError(run.id);
    }

    /** 取消整组回答：不带答案，只把"用户取消"这个结论交回工具 */
    const cancelled = input.cancelled === true;
    const answers = input.answers ?? [];
    const definition = this.registry.resolve(conversation.agentKey);
    const startedAt = Date.now();
    const abort = new AbortController();
    this.activeRuns.set(run.id, abort);

    let heartbeat: NodeJS.Timeout | undefined;
    let streamStarted = false;
    const stopHeartbeat = (): void => {
      if (!heartbeat) return;
      clearInterval(heartbeat);
      heartbeat = undefined;
    };
    const ensureHeartbeat = (): void => {
      if (heartbeat) return;
      heartbeat = setInterval(() => {
        void this.runs.touchHeartbeat(run.id).catch(() => undefined);
        if (streamStarted) writeSse(response, ': ping\n\n');
      }, STREAM_HEARTBEAT_MS);
      heartbeat.unref?.();
    };

    /** 首 token 看护：续跑同样要防"模型卡住不吐字"（与 chatStream 同一口径） */
    let firstTokenTimer: NodeJS.Timeout | undefined;
    let firstTokenTimedOut = false;
    let firstTokenSeen = false;
    const stopFirstTokenTimer = (): void => {
      if (!firstTokenTimer) return;
      clearTimeout(firstTokenTimer);
      firstTokenTimer = undefined;
    };
    const armFirstTokenTimer = (): void => {
      const timeoutMs = this.config.firstTokenTimeoutMs;
      if (!timeoutMs || firstTokenTimer) return;
      firstTokenTimer = setTimeout(() => {
        firstTokenTimedOut = true;
        abort.abort();
      }, timeoutMs);
      firstTokenTimer.unref?.();
    };
    const markFirstTokenSeen = (): void => {
      if (firstTokenSeen) return;
      firstTokenSeen = true;
      stopFirstTokenTimer();
    };

    try {
      const model = await this.resolveRuntimeModel(definition, undefined);
      const modelInstance = await this.resolveModelInstance(model);

      // 挂起期间状态是 suspended；续跑开始先回到 running（占用会话，防止同会话另一轮插进来）
      await this.runs.markRunning(run.id, run.engineRunId);

      const requestContext = await this.buildRuntimeContext(
        conversation.id,
        run.id,
        definition,
        userId,
        model,
        {
          abortSignal: abort.signal,
          systemPrompt: await this.resolveSystemPrompt(conversation, run.id, definition),
          // 续跑与首轮同一身份口径：admin 的 skill-* 工具不能因为"续跑"而消失
          isAdmin,
        },
      );
      const agent = mastra.getAgent(definition.key);
      const memoryThread = await this.ensureAgentThread(conversation.id, userId);
      /**
       * 轮内预算按**这一轮的窗口**算：优先用首轮落库的上下文快照（同一份判定），
       * 快照没有（旧数据）就现场解析一次。续跑的步数通常不多，但"套用首轮口径"
       * 能让同一条 run 的两段用同一个预算，不出现第二段突然收紧。
       */
      const windowTokens =
        (run.requestSnapshot?.context as { windowTokens?: number } | undefined)?.windowTokens ??
        this.context.resolveWindow(model.modelRef).windowTokens;
      const runOptions = {
        runId: run.engineRunId,
        // 与 chatStream 同一口径：续跑必须给足步数。
        // 不传时 Mastra 默认 maxSteps=5 —— 续跑会在第 5 步悄悄结束，
        // 表现为"壳体建完就断了，要用户再发一句继续"（会话 rfitk3uq... 实测）。
        maxSteps: AGENT_MAX_STEPS,
        // 续跑后的下一段同样可能派子 agent：并发策略与主路径一致
        toolCallConcurrency: AGENT_TOOL_CONCURRENCY,
        requestContext,
        model: modelInstance as never,
        abortSignal: abort.signal,
        memory: memoryThread,
        savePerStep: true,
        // 轮内预算：与首轮同一口径
        prepareStep: this.buildPrepareStep(windowTokens),
      };
      armFirstTokenTimer();
      const resumeOutput = await agent.resumeStream(
        cancelled ? { cancelled: true } : { answers },
        {
          ...runOptions,
          ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
        },
      );

      response.writeHead(200, UI_STREAM_HEADERS);
      streamStarted = true;
      ensureHeartbeat();

      const recorder = new StreamRecorder(
        this.timelines,
        { conversationId: conversation.id, runId: run.id },
        {
          metas: this.toolMetas,
          isKnownTool: (toolKey) => Boolean(this.toolRegistry.get(toolKey)),
        },
      );

      let suspendedAgain = false;
      const consume = async (stream: unknown): Promise<void> => {
        const reader = (
          toUiStream(stream as never) as unknown as ReadableStream<UiChunkLike>
        ).getReader();
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          const chunk = next.value;
          // `data-tool-call-suspended` 有两种：新的挂起（resumed=false）和续跑成功
          // （resumed=true）。后者只是同一个工具从挂起点继续，不能当成"又问了下一个问题"。
          const resumedEvent =
            chunk.type === 'data-tool-call-suspended' &&
            (chunk as { data?: { resumed?: boolean } }).data?.resumed === true;
          if (chunk.type === 'data-tool-call-suspended' && !resumedEvent) suspendedAgain = true;
          if (
            chunk.type === 'text-delta' ||
            chunk.type === 'reasoning-delta' ||
            chunk.type === 'tool-input-available'
          ) {
            markFirstTokenSeen();
          }
          const recordedChunk = normalizeSuspendedChunk(chunk, run.id);
          const outgoing = toClientToolChunk(recordedChunk);
          writeSse(response, sseFrame(outgoing));
          await recorder.consume(recordedChunk);
          if (suspendedAgain) break;
        }
      };

      await consume(resumeOutput);
      /**
       * 挂起工具的"结果"由我们补一条时间线：Mastra 的 resume 流只发
       * `tool-call-resumed`，不会把 ask-user-questions 的出参再发一遍。
       * 没有这行，历史重建会把已回答的问题卡又当成待回答显示出来。
       */
      if (input.toolCallId) {
        const existing = await this.timelines.findToolOutput(
          conversation.id,
          input.toolCallId,
        );
        if (existing === null) {
          await this.timelines.append({
            conversationId: conversation.id,
            runId: run.id,
            role: TimelineRole.Assistant,
            kind: TimelineKind.ToolResult,
            toolKey: 'ask-user-questions',
            toolCallId: input.toolCallId,
            payload: {
              output: cancelled
                ? { cancelled: true, answers: [] }
                : { answers },
            },
          });
        }
      }
      // resume 只恢复了工具；要继续 agentic loop，再起一段**新引擎 run**，
      // 复用同一个 memory thread。旧 engine run 已经结束，拿它调 stream 不会发起模型调用。
      // 旧引擎 run 可能还占着 agent 的 active stream 槽位；先放掉，否则新 stream 不发起模型调用
      agent.abortRunStream?.(run.engineRunId)
      const { runId: _finishedEngineRunId, ...continuationOptions } = runOptions;
      const answerText = answers
        .map(
          (answer) =>
            `- ${answer.id}: ${Array.isArray(answer.value) ? answer.value.join('、') : answer.value}`,
        )
        .join('\n');
      const continuationMessage = cancelled
        ? '用户取消了这组问题的回答（选择不回答）。不要再重复提问；请基于已有信息继续推进，确实缺少关键信息时说明影响并给出可执行的下一步。'
        : `用户已回答：\n${answerText}\n\n请基于这些回答继续。`;
      const output = suspendedAgain
        ? resumeOutput
        : await agent.stream(
            [{ role: 'user', content: continuationMessage }],
            continuationOptions,
          );
      if (!suspendedAgain) {
        const nextEngineRunId = (output as { runId?: string }).runId;
        if (nextEngineRunId) await this.runs.attachEngineRun(run.id, nextEngineRunId);
        await consume(output);
      }
      await recorder.flushPending();

      const steps = (await readStreamSteps(output)) as unknown as StepLike[];
      const persisted = await recorder.finish(steps);
      const priorUsage = (run.usage ?? null) as Record<string, unknown> | null;
      const resumedUsage = await this.rollUpUsage(
        run.id,
        toUsageRecord(await readStreamUsage(output)),
      );
      const usage = priorUsage ? (mergeUsage(priorUsage, resumedUsage) ?? resumedUsage) : resumedUsage;

      // 续跑后模型又问了下一个问题：仍然停在 suspended，不能当成成功。
      if (suspendedAgain) {
        await this.runs.suspend(run.id, {
          usage,
          stepCount: (run.stepCount ?? 0) + steps.length,
          toolCallCount: (run.toolCallCount ?? 0) + persisted.toolCallCount,
          durationMs: (run.durationMs ?? 0) + (Date.now() - startedAt),
        });
        await this.runs.setActiveStream(run.id, null);
        stopHeartbeat();
        writeSse(response, 'data: [DONE]\n\n');
        endSse(response);
        return;
      }
      const stepCount = (run.stepCount ?? 0) + steps.length;
      const toolCallCount = (run.toolCallCount ?? 0) + persisted.toolCallCount;
      const durationMs = (run.durationMs ?? 0) + (Date.now() - startedAt);

      await this.runs.finish(run.id, {
        status: RunStatus.Succeeded,
        usage,
        stepCount,
        toolCallCount,
        durationMs,
      });
      await this.runs.setActiveStream(run.id, null);
      await this.conversationRepo.accumulate(conversation.id, totalTokensOf(usage));
      stopHeartbeat();
      writeSse(response, 'data: [DONE]\n\n');
      endSse(response);
      this.logger.log('ai.stream.resumed', {
        conversationId: conversation.id,
        runId: run.id,
        stepCount: steps.length,
        toolCallCount: persisted.toolCallCount,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (firstTokenTimedOut) {
        const mapped = new ModelNoResponseError(this.config.firstTokenTimeoutMs);
        await this.runs.finish(run.id, {
          status: RunStatus.Failed,
          usage: await this.rollUpUsage(run.id, null),
          errorCode: String(AppErrorCodes.ModelNoResponse),
          errorStage: RunErrorStage.Model,
          errorMessage: mapped.message,
          errorDetail: { raw: reason, timeoutMs: this.config.firstTokenTimeoutMs },
          durationMs: Date.now() - startedAt,
        });
        this.logger.error('ai.stream.resume_first_token_timeout', {
          runId: run.id,
          timeoutMs: this.config.firstTokenTimeoutMs,
        });
      } else if (abort.signal.aborted) {
        await this.runs.finish(run.id, {
          status: RunStatus.Canceled,
          durationMs: Date.now() - startedAt,
        });
        this.logger.log('ai.stream.resume_canceled', { runId: run.id });
      } else {
        await this.runs.finish(run.id, {
          status: RunStatus.Failed,
          usage: await this.rollUpUsage(run.id, null),
          errorCode: String(AppErrorCodes.AgentFailed),
          errorStage: RunErrorStage.Model,
          errorMessage: reason,
          durationMs: Date.now() - startedAt,
        });
        this.logger.error('ai.stream.resume_failed', { runId: run.id, reason });
      }
      await this.runs.setActiveStream(run.id, null);
      if (!streamStarted) throw error;
      writeSse(response, 'data: [DONE]\n\n');
      endSse(response);
    } finally {
      stopHeartbeat();
      stopFirstTokenTimer();
      this.activeRuns.delete(run.id);
      if (streamStarted) endSse(response);
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

    // 挂起中的一轮没有"本进程里的流"可 abort：直接把状态落成 canceled，释放会话。
    // 不处理的话，用户想放弃这一轮只能一直卡在 3306（该会话已有进行中的对话）。
    if (run.status === RunStatus.Suspended) {
      await this.runs.finish(run.id, {
        status: RunStatus.Canceled,
        ...(run.durationMs != null ? { durationMs: run.durationMs } : {}),
      });
      return { stopped: true, injected: 'local' };
    }

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

    /**
     * **Postgres 终态优先于 Redis 进度**：进程崩溃时旧进程没来得及删进度键
     * （TTL 6h），启动清理把 run 标成 `interrupted` 后，Redis 里可能仍写着 `running`。
     * 只看 Redis 会让客户端"接回"一条永远不会有新片段的死流（挂到超时）。
     */
    if (run.status !== RunStatus.Running && run.status !== RunStatus.Pending) {
      return false;
    }

    const progress = await this.streamStore.readRun(runId);
    if (!progress || progress.status !== RunStatus.Running) return false;

    response.writeHead(200, UI_STREAM_HEADERS);
    response.flushHeaders?.();
    // 断线后的补发连接同样可能随时消失：socket 的 error 事件不能变成进程级未捕获异常
    response.on?.('error', () => undefined);

    /**
     * 补发起点不能直接信任 offset：它可能落在 reasoning / text / tool-input 的
     * 中间。AI SDK 的 UI 状态机收到没有 `*-start` 的 delta 会整页报错
     * `Received reasoning-delta for missing reasoning part`。
     *
     * 先读全量（上限 20k 条，正常一轮远小于此），再由 `resumeSafeChunks`
     * 把起点回退到当前块的开头；找不到开头时补 start，孤立 end 丢弃。
     */
    const all = (await this.streamStore.readChunks(runId, 0)) as UiChunkLike[];
    const backlog = resumeSafeChunks(all, offset) as UiChunkLike[];

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
      writeSse(response, sseFrame(chunk));
    }
    if (ended) {
      endSse(response);
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
            writeSse(response, sseFrame(chunk));
          },
          () => undefined,
        )
        .then((fn) => {
          unsubscribe = fn;
        })
        .catch(() => finish());
    });
    endSse(response);
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
      // 子 agent 的工具面 = 父 agent 的授权面 ∩ 全部 − 委派类 − child:deny
      // （"子助手有你的全部工具"里的"你的"指父 agent 被授权的那一份，不是注册机全量）
      childToolbox: this.toolRegistry.childToolbox(definition.tools),
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
  [key: string]: unknown;
}

/** Express Response 的最小接口（只在编排层用，避免把 express 类型铺进来） */
/**
 * 挂起块里的 `runId` 是 Mastra 的 engineRunId（`eng_...`）；前端回答时要调
 * `POST /agent/chat/resume`，参数必须是**应用 run id**。这里换掉并保留 engineRunId。
 */
const normalizeSuspendedChunk = <T extends UiChunkLike>(chunk: T, runId: string): T => {
  if (chunk.type !== 'data-tool-call-suspended') return chunk;
  const data = (chunk.data ?? {}) as Record<string, unknown>;
  return {
    ...chunk,
    data: {
      ...data,
      engineRunId: data.runId ?? null,
      runId,
    },
  } as T;
};

/**
 * 工具把失败当结果返回（顶层 `ok: false`）时，**客户端也按失败呈现**。
 *
 * 录制器那边同样会把它标成 `output-error`（口径一致）；模型看到的数据不变 ——
 * 它已经拿到了这份结果，只是前端与统计不该把它算成"成功"。
 */
const toClientToolChunk = <T extends UiChunkLike>(chunk: T): T => {
  if (chunk.type !== 'tool-output-available') return chunk;
  const failure = toolFailureOf((chunk as { output?: unknown }).output);
  if (!failure.failed) return chunk;
  return {
    ...chunk,
    type: 'tool-output-error',
    errorText: failure.message ?? '工具报告失败（ok: false）',
  } as T;
};

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

/**
 * 向 SSE 响应写一帧（**客户端断开时不抛错**）。
 *
 * 为什么必须包一层：`ServerResponse.write()` 在 socket 已经关闭 / 响应已经 end 时会抛
 * 「Connection is closed.」。此前它直接出现在**心跳定时器**里 —— 定时器回调抛异常 = 进程级
 * `uncaughtException` = `process.exit(1)`，于是"一个客户端刷新页面"就能把整个服务重启，
 * 正在跑的其它会话跟着全丢（排查很久才定位到）。写失败只说明这一帧没人收，返回 false 即可。
 */
const writeSse = (response: StreamResponseLike, chunk: string): boolean => {
  if (response.writableEnded) return false;
  try {
    response.write(chunk);
    return true;
  } catch {
    return false;
  }
};

/** 结束 SSE 响应（幂等；客户端已断开时静默） */
const endSse = (response: StreamResponseLike): void => {
  if (response.writableEnded) return;
  try {
    response.end();
  } catch {
    // 连接已经没了：没有可收尾的对象
  }
};
