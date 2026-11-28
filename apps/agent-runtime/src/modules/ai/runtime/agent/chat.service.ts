import { Inject, Injectable, Optional } from '@nestjs/common'
import dedent from 'dedent'
import { AppError, AppLogger } from '@repo/kits'
import {
  AppErrorCodes,
  RunErrorStage,
  RunStatus,
  TimelineKind,
  TimelineRole,
  encodeAgUiChunk,
  isRunFinalEvent,
  estimateContentTokens,
  type AgentChatDto,
  type AgentChatResumeDto,
  type AgentChatResultModel,
  type AgentRunStopResultModel,
  type AgUiChunk,
  type ChatAttachmentModel,
} from '@repo/shared'
import type { Mastra } from '@mastra/core/mastra'
import { AGENT_MAX_STEPS, AGENT_TOOL_CONCURRENCY } from '../../foundation/constants.js'
import { AgentConfig, type AgentConfig as AgentConfigValue } from '../../foundation/config.js'
import { createTaskId } from '../../engine/task-id.js'
import {
  AgentFailedError,
  AgentUnavailableError,
  ConversationBusyError,
  ModelNoResponseError,
  ProviderAuthFailedError,
  ProviderRateLimitedError,
  RunNotFoundError,
  RunNotSuspendedError,
} from '../../foundation/errors.js'
import { AGENT_REGISTRY } from '../../domain/agents/registry.js'
import { MASTRA } from '../../adapters/mastra/ai.mastra.js'
import {
  AGENT_MEMORY,
  agentMemory as sharedAgentMemory,
  memoryHistoryOptions,
} from '../../adapters/mastra/agent-memory.js'
import { type RuntimeModel } from '../../foundation/envelope.js'
import { RUNTIME_MODEL_RESOLVER, type RuntimeModelResolver } from '../model/model-resolver.js'
import { cancelRemoteRunTasks } from '../common/remote-tool.client.js'
import type { AgentDefinition, AgentRegistry } from '../../domain/agents/types.js'
import { WorkspaceEnvironmentClient } from '../workspace/workspace-environment.client.js'
import { PROMPT_ENGINE, type PromptEngine } from '../../foundation/prompts/prompt.engine.js'
import { SkillLoader } from '../../tools/skills/index.js'
import { ToolRegistry } from '../../tools/engine/tool.registry.js'
import { REMOTE_TOOL_INVOKER, type RemoteToolInvoker } from '../../tools/engine/tool.ports.js'
import { GatewayToolCatalog } from '../model/gateway-capability-catalog.js'
import { ToolCallMetaStore } from '../../tools/engine/tool.meta.js'
import { ToolDiscoveryStore } from '../../tools/engine/tool-discovery.store.js'
import { MastraModelClient } from '../../engine/adapters/model-client.adapter.js'
import { EngineTelemetry } from '../../engine/engine-telemetry.js'
import type { ConversationEntity, ConversationRunQueueEntity, TimelineEntity } from '@repo/db'
import { AgentConversationService } from '../conversation/conversation.service.js'
import { AgentTitleService } from '../conversation/title.service.js'
import { ContextService } from '../context/context.service.js'
import { ChatAttachmentService, withUserContent } from '../attachments/chat-attachment.service.js'
import { ConversationRepository } from '../conversation/conversation.repository.js'
import { RunRepository } from '../run/run.repository.js'
import { ConversationRunQueue } from '../queue/run-queue.service.js'
import { RunStatusStream } from '../run/run-status.stream.js'
import { TimelineRepository } from '../run/timeline.repository.js'
import { FileService, type FileContext } from '../../domain/files/file.service.js'
import { AttachmentKeyPolicy } from '../attachments/attachment-key.js'
import { MemoryService } from '../../domain/memory/memory.service.js'
import { MemoryExtractorService } from '../../domain/memory/memory.extractor.service.js'
import { toRehydrateMessages } from '../../domain/memory/memory.rehydrate.js'
import { AgentStreamStore } from '../stream/stream-store.service.js'
import { StreamRecorder, toolFailureOf } from '../stream/stream-recorder.js'
import { AgUiEmitter } from '../stream/agui-emitter.js'
import { TurnWatchdog } from './turn-watchdog.js'
import { TurnChunkPump, type UiChunkLike } from './turn-chunk-pump.js'
import { prepareRuntime, prepareTurn, type PrepareTurnDeps } from './turn-preparer.js'
import { finishFailedTurn, finishSucceededTurn, finishSuspendedTurn } from './turn-finalizer.js'
import { fitMessagesToToolBudget } from '../context/turn-budget.js'
import { readStreamSteps, readStreamUsage } from '../stream/stream-result.js'
import { createLiveUsage } from '../run/live-usage.js'
import { coalesceDeltas, resumeSafeChunks } from '../stream/stream-resume.js'
import { buildRunSnapshot, decodeRecords, openPartChunks } from '../run/run-snapshot.js'
import { mergeUsage, toUsageRecord } from '../run/usage.js'
import { writeFallbackTitle, type FirstTurnTitleDeps } from '../conversation/first-turn-title.js'
import { persistSteps, type StepLike } from './step-persister.js'
import {
  snapshotRun,
  snapshotCurrentRun,
  loadSnapshotData,
  type RunSnapshotDeps,
} from '../run/run-snapshot.service.js'
import { rollUpUsage } from '../run/usage-roller.js'
import {
  buildRuntimeContext,
  resolveSystemPrompt,
  type RuntimeContextDeps,
} from '../context/runtime-context.builder.js'
import {
  STREAM_END_MARKER,
  UI_STREAM_HEADERS,
  endSse,
  writeSse,
  type StreamResponseLike,
} from '../stream/stream-response.js'
import type {
  ApprovalPort,
  ContextAssembler,
  MemoryPort,
  RunRecorderFactory,
  StreamPublisher,
  ToolFace,
} from '../../engine/ports.js'
import {
  APPROVAL_PORT,
  CONTEXT_ASSEMBLER,
  MEMORY_PORT,
  RUN_RECORDER_FACTORY,
  STREAM_PUBLISHER,
  TOOL_FACE,
} from '../../engine/tokens.js'

/** 并发保护的唯一索引名（同一会话同时只允许一轮进行中） */
const ACTIVE_RUN_CONSTRAINT = 'uk_run_active_conversation'

/** PG 错误的最小结构（TypeORM 会把它放在 driverError 里） */
interface PgError {
  code?: string
  constraint?: string
  detail?: string
}

/**
 * 用户消息的落库载荷。
 *
 * 没有附件时形状与过去**逐字节一致**（`{ text }`）—— 历史数据与既有渲染路径不受影响；
 * 有附件才多一个 `attachments`（只存存储 key 与文件元数据，**不存文件内容**：
 * 图片转 base64 动辄几 MB，塞进 jsonb 会把这张审计表撑变形，回看历史时按 key 再解析即可）。
 */

/** 队列 payload 的最小结构（jsonb 里存的是 unknown，读回来必须自己收口） */
interface QueuedUserPayload {
  message: string
  modelId?: string
  attachments?: ChatAttachmentModel[]
  isAdmin: boolean
  /** 入站请求 id（排队后仍能把它串回同一条审计链路） */
  requestId?: string
}

/**
 * 同一批子助手的进度（`agent-runner` 入队时算好）。
 *
 * 为什么由引擎算：父 agent 每收到一个完成通知都要判断「还有没有在跑」，
 * 自己数就得来回查库 / 调工具；把名字直接写进通知，它只需要决定「继续做别的」还是「可以汇总了」。
 */
interface SubAgentWakeProgress {
  /** 本批子助手总数（按 run 计） */
  total: number
  /** 已进入终态的数量（含刚完成的这个） */
  completed: number
  /** 仍在跑的子助手名字；为空数组 = 这一批全完了 */
  pending: string[]
}

/** 子 agent 完成唤醒的 payload（口径见 `docs/design/async-subagent.md` §3.1 / §6.1） */
interface SubAgentWakePayload {
  subAgentId: string
  subRunId: string
  name: string
  status: string
  result: string | null
  error: string | null
  /** 结论落在工作区的文件（`subagents/...md`）；有它时通知只给路径与大小，不贴全文 */
  resultPath: string | null
  resultBytes: number | null
  resultLines: number | null
  /** 同批进度（同一父 run 下还有谁在跑） */
  progress?: SubAgentWakeProgress
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null

const asText = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null

/** 用户排队消息 payload → 结构；缺 message 返回 null（调用方按"无法调度"失败） */
const toQueuedUser = (payload: Record<string, unknown>): QueuedUserPayload | null => {
  const message = asText(payload.message)
  if (message === null) return null
  const attachments = Array.isArray(payload.attachments)
    ? (payload.attachments as ChatAttachmentModel[])
    : undefined
  const requestId = asText(payload.requestId)
  return {
    message,
    isAdmin: payload.isAdmin === true,
    ...(asText(payload.modelId) ? { modelId: asText(payload.modelId) as string } : {}),
    ...(attachments && attachments.length > 0 ? { attachments } : {}),
    ...(requestId ? { requestId } : {}),
  }
}

/** 子 agent 完成 payload → 结构；缺身份三件套返回 null */
const toSubAgentWake = (payload: Record<string, unknown>): SubAgentWakePayload | null => {
  const subAgentId = asText(payload.subAgentId)
  const subRunId = asText(payload.subRunId)
  const name = asText(payload.name)
  if (!subAgentId || !subRunId || !name) return null
  const progress = toSubAgentWakeProgress(payload.progress)
  return {
    subAgentId,
    subRunId,
    name,
    status: asText(payload.status) ?? 'succeeded',
    result: asText(payload.result),
    error: asText(payload.error),
    resultPath: asText(payload.resultPath),
    resultBytes: typeof payload.resultBytes === 'number' ? payload.resultBytes : null,
    resultLines: typeof payload.resultLines === 'number' ? payload.resultLines : null,
    ...(progress ? { progress } : {}),
  }
}

/** 进度 → 结构（字段不认识就丢，不让一条脏 payload 炸掉整轮唤醒） */
const toSubAgentWakeProgress = (value: unknown): SubAgentWakeProgress | null => {
  const record = asRecord(value)
  if (!record) return null
  const total = typeof record.total === 'number' ? record.total : 0
  if (total <= 0) return null
  return {
    total,
    completed: typeof record.completed === 'number' ? record.completed : 0,
    pending: Array.isArray(record.pending)
      ? record.pending.filter((item): item is string => typeof item === 'string')
      : [],
  }
}

/**
 * 给父模型的**内部系统通知**（内容不是用户说的，但**角色走 user**）。
 *
 * 为什么角色是 user：模型只把「最后一条 user」当成这一轮要回应的任务；走 system 时它会
 * 回退到最近的 user 消息（会话开头那条原问题），误判成「用户重复提问」并重复作答
 * （2026-11-15 实测：一次会话被误判 4 次，多烧约 220 万 token）。
 * 「不是用户说的」这层语义由**首尾两处加粗文案**承担，不靠角色区分。
 * 时间线仍不写用户消息 —— 只写一张系统卡。
 */
/** 字节数 → 人话（通知里只给"有多大"，不给正文） */
const formatBytes = (bytes: number | null): string => {
  if (bytes === null) return '大小未知'
  return bytes >= 1024 ? `${Math.round(bytes / 1024)} KB` : `${bytes} B`
}

const wakeNoticeText = (wake: SubAgentWakePayload): string => {
  const succeeded = wake.status === 'succeeded'
  const head = succeeded
    ? `子 agent「${wake.name}」已完成（subRunId=${wake.subRunId}）。`
    : `子 agent「${wake.name}」执行失败（状态：${wake.status}，subRunId=${wake.subRunId}）。`
  const body = succeeded
    ? wake.resultPath
      ? `它的结论已写入工作区：${wake.resultPath}（${formatBytes(wake.resultBytes)}${
          wake.resultLines !== null ? ` / ${wake.resultLines} 行` : ''
        }）。需要内容用 read-file 读这个路径（按行分页、可续读）。`
      : wake.result && wake.result.trim()
        ? '它没有把结论写成文件；完整内容请查看它的子会话。'
        : '它没有返回文本结论。'
    : wake.error
      ? `失败原因：${wake.error}`
      : '没有拿到失败原因。'
  const progress = wake.progress
    ? wake.progress.pending.length > 0
      ? `本批共 ${wake.progress.total} 个子助手：已完成 ${wake.progress.completed} 个，还有 ${wake.progress.pending.length} 个在跑（${wake.progress.pending.join('、')}）。先做别的，等它们完成；全部到齐后再做最终汇总。`
      : `本批共 ${wake.progress.total} 个子助手已全部结束，现在可以做最终汇总。`
    : ''
  return dedent`
    **［subagent-completion · 内部系统通知，不是用户的新消息］** ${head}
    ${body}

    ${progress}
    用户**没有**再发新消息：不要把这当成「用户重复提问」，也不要重答已经答过的内容。
    请基于上面的结论继续推进 —— 把子助手的结论合进已交付的答案 / 文件，需要细节可查看子会话；
    失败时判断是重试、换方案，还是向用户说明并给出下一步。
  `
}

/** 系统卡 payload：写时间线 + 作为 `data-subagent-completed` 实时块（前端同一形状） */
const wakeCard = (wake: SubAgentWakePayload): Record<string, unknown> => ({
  status: 'subagent_completed',
  subAgentId: wake.subAgentId,
  subRunId: wake.subRunId,
  name: wake.name,
  childStatus: wake.status,
  // 取**尾部**：`result` 是子 agent 全部文本的拼接，开头是「我会先…」的过程叙述，
  // 结论在最后。取头部只会让卡片显示开场白（2026-11-15 实测卡片里看不到结论）。
  summary: wake.result ? wake.result.slice(-500) : null,
  error: wake.error,
  childConversationId: wake.subAgentId,
  // 同批进度（前端可忽略；有它就是「还有谁在跑」）
  ...(wake.progress ? { progress: wake.progress } : {}),
})

/**
 * 上游错误分类：鉴权失败 / 限流 单独成码，其余归通用失败。
 *
 * **我们自己抛的业务错（`AppError` 家族）原样返回**（踩过）：早先这里无条件包一层
 * `AgentFailedError`，于是 3402「模型已禁用」/3406「还没配模型」这些**明确、可行动**的错误码
 * 全被降级成 3302「AI 回复失败」—— 前端只能显示一句泛泛的失败，
 * "去后台启用模型"这种修复动作就传递不出去（错误码的意义正在于此）。
 */
const classifyModelError = (error: unknown): Error => {
  if (error instanceof AppError) return error
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
  if (
    lower.includes('429') ||
    lower.includes('rate limit') ||
    lower.includes('too many requests')
  ) {
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
    @Inject(RUNTIME_MODEL_RESOLVER) private readonly models: RuntimeModelResolver,
    @Inject(AppLogger) private readonly logger: AppLogger,
    @Inject(PROMPT_ENGINE) private readonly prompts: PromptEngine,
    @Inject(AgentTitleService) private readonly titles: AgentTitleService,
    // 新增依赖放末尾：手工构造的测试/脚本按位置传参，插在中间会把后面全部错位
    @Inject(FileService) private readonly files: FileService,
    @Inject(AttachmentKeyPolicy) private readonly attachmentKeys: AttachmentKeyPolicy,
    // 手工构造（测试 / 脚本）不传时跳过长期记忆注入；生产由 `ai.module` 提供
    @Optional() @Inject(MemoryService) private readonly memory?: MemoryService,
    // 轮后抽取（同样只在生产注入；手工构造的测试 / 脚本不传就跳过）
    @Optional()
    @Inject(MemoryExtractorService)
    private readonly memoryExtractor?: MemoryExtractorService,
    // 生产由 `ai.module` 注入 Redis 实现；测试 / 脚本手构时缺省，回落到进程内单例
    @Optional() @Inject(AGENT_MEMORY) private readonly injectedMemory?: typeof sharedAgentMemory,
    // 会话 run 队列（异步子 agent 唤醒 / 用户消息排队）：测试 / 脚本不传时退化为"没有队列"
    @Optional() @Inject(ConversationRunQueue) private readonly runQueue?: ConversationRunQueue,
    // 运行态事件（`conversation.run.started`，前端据此自动续流）：不传时跳过推流
    @Optional() @Inject(RunStatusStream) private readonly runEvents?: RunStatusStream,
    // 能力目录：首轮据此把内部服务能力写进系统指令、给子助手补工具面（测试不传则退回本地声明）
    @Optional() @Inject(GatewayToolCatalog) private readonly catalog?: GatewayToolCatalog,
    // 目录能力一律经网关执行；测试不传时目录能力会被跳过
    @Optional() @Inject(REMOTE_TOOL_INVOKER) private readonly remote?: RemoteToolInvoker | null,
    // 会话里通过 `tool-search` 搜到的外部工具（MCP / 手工登记）：子助手与主 agent 同一工具面
    @Optional()
    @Inject(ToolDiscoveryStore)
    private readonly discovery?: ToolDiscoveryStore,
    // 工作区执行环境（提示词「运行环境」段）；测试 / 脚本不传时整段省略（放末尾，别打乱位置参数）
    @Optional()
    @Inject(WorkspaceEnvironmentClient)
    private readonly workspaceEnvironment?: WorkspaceEnvironmentClient,
    // ── 引擎能力接缝（S1 适配器；手工构造 / 测试缺省时回落到原有具体服务）──
    @Optional() @Inject(CONTEXT_ASSEMBLER) private readonly contextAssembler?: ContextAssembler,
    @Optional() @Inject(STREAM_PUBLISHER) private readonly streamPublisher?: StreamPublisher,
    @Optional() @Inject(RUN_RECORDER_FACTORY) private readonly recorderFactory?: RunRecorderFactory,
    @Optional() @Inject(TOOL_FACE) private readonly toolFacePort?: ToolFace,
    @Optional() @Inject(MEMORY_PORT) private readonly memoryPort?: MemoryPort,
    @Optional() @Inject(APPROVAL_PORT) private readonly approvalPort?: ApprovalPort,
    @Optional() @Inject(EngineTelemetry) private readonly engineTelemetry?: EngineTelemetry,
  ) {
    this.agui = new AgUiEmitter(this.streams, this.logger)
  }

  /** 流接缝：生产走适配器，测试 / 脚本直接用具体存储 */
  private get streams(): StreamPublisher {
    return this.streamPublisher ?? this.streamStore
  }

  /** 工具面接缝：生产走适配器，测试 / 脚本直接用注册机 */
  private get toolFace(): ToolFace {
    return this.toolFacePort ?? this.toolRegistry
  }

  /** AG-UI 发射器：事件编码 / 增量合并 / 输出记录 / 广播 */
  private readonly agui: AgUiEmitter

  /** 准备阶段依赖（模型 / 上下文 / 快照 / 用户消息 / 信封 / thread） */
  private get prepareDeps(): PrepareTurnDeps {
    return {
      models: this.models,
      runs: this.runs,
      timelines: this.timelines,
      toolFace: this.toolFace,
      skillLoader: this.skillLoader,
      titleDeps: this.titleDeps,
      runtimeContextDeps: this.runtimeContextDeps,
      buildContext: (
        conversationId,
        userId,
        definition,
        userMessage,
        model,
        attachments,
        internalNotice,
      ) =>
        this.buildContext(
          conversationId,
          userId,
          definition,
          userMessage,
          model,
          attachments,
          internalNotice,
        ),
      ensureThread: (conversationId, userId) => this.ensureAgentThread(conversationId, userId),
      rehydrateThread: (conversationId, userId) =>
        this.rehydrateThreadIfEmpty(conversationId, userId),
    }
  }

  private get titleDeps(): FirstTurnTitleDeps {
    return {
      conversations: this.conversationRepo,
      titles: this.titles,
      logger: this.logger,
      runEvents: this.runEvents ?? null,
    }
  }

  private get snapshotDeps(): RunSnapshotDeps {
    return {
      runs: this.runs,
      conversations: this.conversations,
      streams: this.streams,
      timelines: this.timelines,
    }
  }

  private get summarizerDeps() {
    return { timelines: this.timelines, logger: this.logger }
  }

  private get runtimeContextDeps(): RuntimeContextDeps {
    return {
      tools: this.toolRegistry,
      catalog: this.catalog ?? null,
      remote: this.remote ?? null,
      discovery: this.discovery ?? null,
      skills: this.skillLoader,
      prompts: this.prompts,
      workspace: this.workspaceEnvironment ?? null,
      timelines: this.timelines,
      logger: this.logger,
    }
  }

  /** 主 agent 的对话记忆（与 createMastra 共用同一个实例） */
  private get agentMemory(): typeof sharedAgentMemory {
    return this.injectedMemory ?? sharedAgentMemory
  }

  /**
   * 已知工具 = 本进程注册机 ∪ 网关目录。
   *
   * 目录能力（bash / file-* / credential-*）不在注册机里；只查注册机会把它们的所有拒绝
   * 一律标成 `unknown-tool`，时间线与模型都读不出真实原因（issue 11）。
   */
  private isKnownToolKey = (toolKey: string): boolean =>
    this.toolFace.has(toolKey) || (this.catalog?.has(toolKey) ?? false)

  private async ensureAgentThread(
    conversationId: string,
    userId: string,
  ): Promise<{ thread: string; resource: string }> {
    const existing = await this.agentMemory.getThreadById({ threadId: conversationId })
    if (!existing) {
      await this.agentMemory.createThread({
        threadId: conversationId,
        resourceId: userId,
        title: conversationId,
      })
    }
    return { thread: conversationId, resource: userId }
  }

  /**
   * 续跑前补齐 thread（设计 `docs/design/ai-memory.md` §4.4）。
   *
   * 为什么需要：thread 落 Redis 后，重启/换副本通常不丢；但 Redis 清空、过期清理、
   * 或者旧版本留下的空 thread 都会让 `resumeStream` 只剩工具状态、发不起下一次模型调用。
   * 这里用 `timelines` 里最近的**文本消息**回灌一份"对话骨架"——工具调用/结果由 durable
   * 快照负责，不回灌（回灌反而可能与快照打架）。
   *
   * 只在 thread 没有任何消息时执行；已有内容说明续跑所需的上下文还在。
   */
  private async rehydrateThreadIfEmpty(conversationId: string, userId: string): Promise<number> {
    const recalled = await this.agentMemory.recall({ threadId: conversationId, perPage: 1 })
    if (recalled.messages.length > 0) return 0

    const thread = await this.agentMemory.getThreadById({ threadId: conversationId })
    if (!thread) {
      await this.agentMemory.createThread({
        threadId: conversationId,
        resourceId: userId,
        title: conversationId,
      })
    }

    const events = await this.timelines.listSince(conversationId, 0, 200, { rootOnly: true })
    const messages = toRehydrateMessages(events, conversationId, userId)
    if (messages.length === 0) return 0

    await this.agentMemory.saveMessages({ messages: messages as never })
    this.logger.warn('ai.memory.thread_rehydrated', { conversationId, count: messages.length })
    return messages.length
  }

  /** 本进程内活动运行的中止控制器（跨副本经 Redis 停止频道广播） */
  private readonly activeRuns = new Map<string, AbortController>()

  async chat(userId: string, input: AgentChatDto, isAdmin = false): Promise<AgentChatResultModel> {
    const mastra = this.requireMastra()
    const conversation = await this.resolveConversation(userId, input)
    const definition = this.registry.resolve(input.agentKey ?? conversation.agentKey)

    const run = await this.startRun(conversation, definition.key, userId, 'user', {
      requestId: this.requestIdOf(input),
    })
    await this.registerInboundFiles(conversation, run.id, userId, isAdmin, input.attachments)
    await this.notifyRunStarted(conversation.id, run.id, 'user')
    const startedAt = Date.now()

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
      const prepared = await prepareTurn(this.prepareDeps, {
        conversation,
        definition,
        run,
        userId,
        isAdmin,
        input,
        origin: 'user',
        writeUserMessage: true,
      })
      const { model, modelInstance, built, titlePromise } = prepared
      const { requestContext, memoryThread } = await prepareRuntime(this.prepareDeps, {
        conversation,
        definition,
        run,
        userId,
        isAdmin,
        model,
        origin: 'user',
        userMessage: input.message,
      })
      const agent = mastra.getAgent(definition.key)
      const result = await agent.generate(built.messages as never, {
        maxSteps: AGENT_MAX_STEPS,
        // 工具调用并发策略：只有真的调用了挂起类工具的那一步串行，其余按并发跑
        // （子 agent 的并行由此打开；同时跑几个由 AgentRunner 的闸门管，见 constants.ts）
        toolCallConcurrency: AGENT_TOOL_CONCURRENCY,
        requestContext,
        // 与流式同一口径：历史来自同一个 thread，预算按这一轮的窗口算
        memory: {
          ...memoryThread,
          options: memoryHistoryOptions(built.snapshot.windowTokens),
        },
        // 显式传模型实例：不依赖 Agent 上的动态 model（Mastra 自解析配置那一层曾丢过多模态，见 resolveModelInstance）
        model: modelInstance.mastraInstance as never,
        // 与流式同一口径：引擎 runId 由我们定、并回写到 `runs.engine_run_id`（durable 快照靠它认亲）
        runId: run.engineRunId,
        // 轮内预算：每一步前把工具结果的累计体积压回窗口预算内
        prepareStep: this.buildPrepareStep(built.snapshot.windowTokens),
      })

      // ④ 逐事件落时间线（保真：文本 / 推理 / 工具入参出参 / 每步用量）
      const steps = (result.steps ?? []) as unknown as StepLike[]
      const persisted = await persistSteps(
        { timelines: this.timelines },
        conversation.id,
        run.id,
        steps,
      )

      // ⑤ 记忆抽取仍在收尾（它要读完整一轮）；命名已与主回答并行跑完，这里只等它并账
      const extracted = await this.extractMemory({
        conversationId: conversation.id,
        runId: run.id,
        userId,
        agentKey: definition.key,
        userMessage: input.message,
        turnCount: conversation.turnCount,
        model,
      })
      const title = await titlePromise

      // ⑤ 收尾：终态 + 消耗（含子 agent 汇总与这次命名）+ 统计 + 会话累计 + 标题
      const usageBase = await rollUpUsage(
        this.runs,
        run.id,
        toUsageRecord(result.totalUsage ?? result.usage ?? null),
      )
      // 并账要**保留 usageBase 里的非 token 字段**（如 `subAgents`）：
      // `mergeUsage` 只逐字段加 token，直接把它的结果当 usage 会把那些字段抹掉（踩过：子 agent 明细消失）
      // 并账：命名 + 记忆抽取的用量都要进这一轮的账（mergeUsage 只加 token，非 token 字段要保留）
      let usage = usageBase
      for (const extra of [title?.usage, extracted?.usage]) {
        if (extra) usage = { ...usage, ...mergeUsage(usage, extra) }
      }
      const durationMs = Date.now() - startedAt
      await finishSucceededTurn(
        {
          runs: this.runs,
          conversations: this.conversationRepo,
          logger: this.logger,
          emitUsage: async () => undefined,
        },
        {
          runId: run.id,
          conversationId: conversation.id,
          usage,
          stepCount: steps.length,
          toolCallCount: persisted.toolCallCount,
          durationMs,
          firstTokenMs: null,
          logEvent: 'ai.chat.succeeded',
          logFields: { agentKey: definition.key },
          skipActiveStream: true,
          skipUsageEvent: true,
        },
      )

      clearInterval(heartbeat)
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
      await finishFailedTurn(
        {
          runs: this.runs,
          timelines: this.timelines,
          logger: this.logger,
          cascadeStop: (runId, conversationId) => this.cascadeStop(runId, conversationId),
          writeFallbackTitle: () => writeFallbackTitle(this.titleDeps, conversation, input.message),
        },
        {
          kind: 'failed',
          runId: run.id,
          conversationId: conversation.id,
          durationMs,
          reason: mapped.message,
          mapped,
          logEvent: 'ai.chat.failed',
          writeTitle: true,
          clearActiveStream: false,
        },
      )
      clearInterval(heartbeat)
      throw mapped
    }
  }

  /** 会话：给了 id 就校验归属；没给就新建 */
  private async resolveConversation(
    userId: string,
    input: AgentChatDto,
  ): Promise<ConversationEntity> {
    if (input.conversationId) {
      const conversation = await this.conversations.requireOwned(userId, input.conversationId)
      // 会话级设置随每轮同步（多端一致性）：界面传了就以它为准
      if (input.fileAccess && conversation.fileAccess !== input.fileAccess) {
        await this.conversationRepo.setFileAccess(conversation.id, input.fileAccess)
        conversation.fileAccess = input.fileAccess
      }
      return conversation
    }
    const created = await this.conversations.create(userId, {
      agentKey: input.agentKey,
      // 只决定沙箱内的写权限；"要不要沙箱"是部署配置
      ...(input.fileAccess ? { fileAccess: input.fileAccess } : {}),
    })
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
  /**
   * 入站附件登记 + 物化（best-effort）。
   *
   * 登记发生在附件归属校验之后（ChatAttachmentService 内部会再校验一次）；
   * 失败只记日志，不阻塞这一轮 —— 附件仍会喂给模型，文件树 / file-download 可以后续补。
   */
  private async registerInboundFiles(
    conversation: ConversationEntity,
    runId: string,
    userId: string,
    isAdmin: boolean,
    attachments: AgentChatDto['attachments'],
  ): Promise<void> {
    if (!attachments || attachments.length === 0) return
    // 手工构造的旧测试可能没有这两个依赖；真实装配里一定在
    if (!this.files || !this.attachmentKeys) return
    // 先校验归属，再登记：伪造 key 不能进 ai_files（与附件读取同一道门）
    this.attachmentKeys.assertOwned(attachments.map((attachment) => attachment.key))
    const ctx: FileContext = {
      conversationId: conversation.id,
      ...(conversation.workspaceId ? { workspaceId: conversation.workspaceId } : {}),
      ...(conversation.workdir ? { workdir: conversation.workdir } : {}),
      userId,
      isAdmin,
      runId,
      toolCallId: null,
    }
    await this.files.registerInbound(ctx, attachments)
    await this.files.materializeInbound(ctx, attachments)
  }

  /** 入站请求 id：main 透传 `x-request-id`，经命令体带进来（可能没有） */
  private requestIdOf(input: AgentChatDto): string | undefined {
    const value = (input as { requestId?: unknown }).requestId
    return typeof value === 'string' && value.length > 0 ? value : undefined
  }

  private async startRun(
    conversation: ConversationEntity,
    agentKey: string,
    userId: string,
    origin: 'user' | 'subagent' = 'user',
    options: { deferStart?: boolean; taskId?: string; requestId?: string } = {},
  ) {
    try {
      const taskId = options.taskId ?? createTaskId()
      const run = await this.runs.create(
        {
          conversationId: conversation.id,
          taskId,
          agentKey,
          status: RunStatus.Pending,
          triggeredBy: userId,
          origin,
          ...(options.requestId ? { requestId: options.requestId } : {}),
        },
        { notify: options.deferStart !== true },
      )
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
      const engineRunId = `eng_${run.id}`
      // 排队调度要等队列项抢到才允许起跑（deferStart）；直接发起的对话照旧立刻 running
      if (!options.deferStart) await this.runs.markRunning(run.id, engineRunId)
      return { ...run, engineRunId }
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
    )
    return (args: { messages?: unknown }) => {
      const result = fitMessagesToToolBudget(args?.messages, { budgetChars })
      if (result.trimmedCount === 0) return undefined
      this.logger.warn('ai.context.turn_trim', {
        budgetChars,
        trimmedCount: result.trimmedCount,
        beforeChars: result.beforeChars,
        afterChars: result.afterChars,
      })
      // Mastra 的 payload 类型是 MastraDBMessage[]；我们只按结构压结果，不改别的字段
      return { messages: result.messages as never }
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
    userId: string,
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
    /** 唤醒 run 的内部系统通知（给了就不写用户消息，模型输入的最后一跳是 system） */
    internalNotice?: string,
  ) {
    /**
     * 生产走上下文接缝（附件多模态 + 长期记忆 + 裁剪/压缩都在适配器里）；
     * 手工构造（测试 / 脚本）没注入时回落到下面的原有实现，行为逐字节一致。
     */
    if (this.contextAssembler) {
      return this.contextAssembler.assemble({
        conversationId,
        userId,
        agentKey: definition.key,
        modelId: model.modelRef,
        systemPrompt: definition.instructions,
        userMessage,
        ...(model.contextWindow ? { windowTokens: model.contextWindow } : {}),
        ...(attachments && attachments.length > 0 ? { attachments } : {}),
        ...(model.inputModalities ? { inputModalities: model.inputModalities } : {}),
        ...(internalNotice ? { internalNotice } : {}),
      })
    }

    const hasAttachments = Boolean(attachments && attachments.length > 0)
    const userContent = hasAttachments
      ? await this.attachments.buildUserContent(userMessage, attachments, model.inputModalities)
      : null

    // 长期记忆：按用户查好注入块（条数与 token 上限由 MemoryService 夹紧，context 只排版）
    const memoryBlock = this.memory ? await this.memory.collect(userId, definition.key) : null

    const built = await this.context.buildInput({
      conversationId,
      // 标识用 `<providerSlug>/<modelKey>`（ContextService 据此查窗口，查不到用兜底值）
      modelId: model.modelRef,
      systemPrompt: definition.instructions,
      userMessage,
      // 库里配过窗口就用它（实测值优先于 tokenlens 的估算）
      ...(model.contextWindow ? { windowTokens: model.contextWindow } : {}),
      ...(userContent ? { extraInputTokens: estimateContentTokens(userContent) } : {}),
      ...(memoryBlock ? { memory: memoryBlock } : {}),
      ...(internalNotice ? { internalNotice } : {}),
    })

    if (!userContent) {
      return built
    }
    /**
     * 把最后一条用户消息换成多模态内容。
     *
     * ⚠️ **别忘了 `agent.stream(..., { model })`**：不显式给模型实例的话，
     * 多模态内容曾在 Mastra 那一层被压平成纯字符串（图片静默丢失）。
     * 回归防线在 `ai-mastra-contract.test.ts` 的"durable 下的多模态"。
     */
    const injected = withUserContent(built.messages, userContent)
    return { ...built, messages: injected }
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
    attribution?: {
      runId: string
      conversationId: string
      identityType: 'user' | 'admin'
      identityId: string
    },
  ): Promise<RuntimeModel> {
    return this.models.resolveForRuntime(modelId ?? definition.model, attribution)
  }

  /**
   * 取"这一轮要用的**模型实例**"。
   *
   * 必须在调用 `agent.stream` / `agent.generate` 时显式传它：Agent 上挂的是**动态 model**
   * （每轮按信封求值），而 Mastra 在那条路径上会把多模态消息的 `content` 压平成纯字符串 ——
   * 图片被静默丢掉。详见 `toMastraModelInstance` 的注释与实测数据。
   */
  private async resolveModelInstance(model: RuntimeModel): Promise<MastraModelClient> {
    return MastraModelClient.create(model)
  }

  /** 轮后记忆抽取：生产走接缝，手工构造回落到具体服务 */
  private extractMemory(input: Parameters<MemoryExtractorService['maybeExtract']>[0]) {
    if (this.memoryPort) return this.memoryPort.extract(input)
    return this.memoryExtractor ? this.memoryExtractor.maybeExtract(input) : Promise.resolve(null)
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
    clientId?: string,
    /**
     * run 建好后的回调（引擎层靠它拿到 runId 并返回 `RunExecution`）。
     *
     * 必须在 `startRun` 之后、任何耗时准备（模型解析 / 上下文组装）之前调用：
     * Host 拿到 runId 才能建立事件订阅，否则建流前的失败会没有可挂的 runId。
     */
    onRunCreated?: (run: { id: string; conversationId: string; taskId: string | null }) => void,
  ): Promise<void> {
    const mastra = this.requireMastra()
    const conversation = await this.resolveConversation(userId, input)
    const definition = this.registry.resolve(input.agentKey ?? conversation.agentKey)

    /**
     * 会话忙（同一会话只允许一轮）时**入队**，不再用 3306 把用户挡回去。
     *
     * 这条 HTTP 连接只回一帧 `data-queue` 就结束（不挂在这里等上一轮跑完：
     * 连接一断消息就丢了）。真正起跑由 dispatcher 按优先级调度；新 run 启动时
     * `conversation.run.started` 会通知前端自动续流（`/agent/run/stream`）。
     */
    let run: { id: string; engineRunId: string; taskId: string | null }
    try {
      run = await this.startRun(conversation, definition.key, userId, 'user', {
        requestId: this.requestIdOf(input),
      })
    } catch (error) {
      if (error instanceof ConversationBusyError && this.runQueue) {
        const queued = await this.enqueueUserMessage(conversation, input, isAdmin)
        this.writeQueuedAck(response, conversation.id, queued, userId, clientId)
        return
      }
      throw error
    }
    onRunCreated?.({ id: run.id, conversationId: conversation.id, taskId: run.taskId })
    await this.registerInboundFiles(conversation, run.id, userId, isAdmin, input.attachments)
    await this.notifyRunStarted(conversation.id, run.id, 'user')
    const startedAt = Date.now()

    // 本进程内中止控制器：**在建流之前就登记**，否则"解析模型时用户点停止"找不到目标
    const abort = new AbortController()
    this.activeRuns.set(run.id, abort)
    if (clientId) await this.streams.bindClient(run.id, clientId)

    let unsubscribeStop: (() => void) | null = null
    /** 响应头是否已经发出（决定失败时是「抛回 HTTP」还是「按 SSE 收尾」） */
    let streamStarted = false
    /** 看护：心跳续租（写 SSE 注释帧）+ 首 token 超时 */
    const watchdog = new TurnWatchdog({
      runs: this.runs,
      runId: run.id,
      firstTokenTimeoutMs: this.config.firstTokenTimeoutMs,
      startedAt,
      onHeartbeat: () => {
        if (streamStarted) writeSse(response, ': ping\n\n')
      },
      onTimeout: () => abort.abort(),
      onFirstToken: (elapsedMs) => this.engineTelemetry?.firstToken(elapsedMs),
    })

    try {
      const prepared = await prepareTurn(this.prepareDeps, {
        conversation,
        definition,
        run,
        userId,
        isAdmin,
        input,
        origin: 'user',
        abortSignal: abort.signal,
        writeUserMessage: true,
      })
      const { model, modelInstance, built, titlePromise } = prepared
      const agent = mastra.getAgent(definition.key)

      // ④ 建流：进度 / 录制器 / 心跳 / 跨副本停止
      const streamId = `${run.id}-${Date.now()}`
      await this.runs.setActiveStream(run.id, streamId)
      if (clientId) await this.streams.bindClient(run.id, clientId)
      await this.streams.startRun(run.id, {
        status: RunStatus.Running,
        stage: 'generating',
        streamId,
        rev: 0,
        step: 0,
      })
      const recorder = new StreamRecorder(
        this.timelines,
        { conversationId: conversation.id, runId: run.id },
        { metas: this.toolMetas, isKnownTool: this.isKnownToolKey },
      )
      const messageIdRef: { value: string } = { value: '' }
      const pump = new TurnChunkPump({
        runId: run.id,
        conversationId: conversation.id,
        recorder,
        agui: this.agui,
        streams: this.streams,
        runs: this.runs,
        logger: this.logger,
        response,
        messageIdRef,
        onFirstToken: () => watchdog.markFirstTokenSeen(),
      })
      watchdog.startHeartbeat()
      // 跨副本停止：订阅本 run 的停止频道（请求落在别的副本时也停得掉）
      try {
        unsubscribeStop = await this.streams.subscribeStop(run.id, () => abort.abort())
      } catch (error) {
        this.logger.warn('ai.stream.stop_subscribe_failed', {
          runId: run.id,
          reason: error instanceof Error ? error.message : String(error),
        })
      }

      const { requestContext, memoryThread } = await prepareRuntime(this.prepareDeps, {
        conversation,
        definition,
        run,
        userId,
        isAdmin,
        model,
        origin: 'user',
        abortSignal: abort.signal,
        userMessage: input.message,
      })

      // 模型可能"卡住不吐字"：从发起调用开始计时，第一段输出到了就撤（见上方 firstTokenTimer）
      watchdog.armFirstToken()
      const output = await agent.stream(built.messages as never, {
        maxSteps: AGENT_MAX_STEPS,
        // 工具调用并发策略：`called` = 只有真的调用了挂起类工具的那一步才串行。
        // 默认的 `available` 会因为工具集里有 ask-user-questions 把**整步**压成串行，
        // 子 agent 于是只能一个一个跑（见 constants.ts 的注释与闸门）
        toolCallConcurrency: AGENT_TOOL_CONCURRENCY,
        abortSignal: abort.signal,
        requestContext,
        // 历史按**这一轮的窗口**给 token 预算（条数不是容量的代理，Mastra 文档同口径）
        memory: {
          ...memoryThread,
          options: memoryHistoryOptions(built.snapshot.windowTokens),
        },
        savePerStep: true,
        // 显式传模型实例：不依赖 Agent 上的动态 model（Mastra 自解析配置那一层曾丢过多模态，见 resolveModelInstance）
        model: modelInstance.mastraInstance as never,
        /**
         * **双方共用一个引擎 runId**：Mastra 的 durable 快照按这个 id 落库，
         * 而我们的存储适配层用 `engine_run_id` 找宿主行 —— id 对不上就丢快照（见 `startRun`）。
         */
        runId: run.engineRunId,
        closeOnSuspend: true,
        // 轮内预算：每一步前把工具结果的累计体积压回窗口预算内（与轮前压缩是两层）
        prepareStep: this.buildPrepareStep(built.snapshot.windowTokens),
      })
      // 子 agent 的实时明细**不走** Mastra 的静态子 agent 通道（我们没有静态子 agent）：
      // 由 `run-sub-agent` 工具经 `context.writer` 写成 `data-sub-agent*` 块进这条流，见 §3.14.5
      //
      // **轮内实时用量**（`data-step-usage`）：v6 UI 流本身不带 usage（适配器在 `finish-step` 处丢掉了），
      // 所以在这里挂一层原始流的 tee，每步结束补发一份累计值；收尾的 `data-run-usage` 仍是权威值。
      const uiStream = createLiveUsage({ runId: run.id, startedAt }).wrap(output)

      const recorded = (uiStream as unknown as ReadableStream<UiChunkLike>).pipeThrough(
        new TransformStream<UiChunkLike, UiChunkLike>({
          transform: async (chunk, controller) => {
            // 先给客户端，再落库：用户的体感不该被落库拖慢
            await pump.consume(chunk, (outgoing) => controller.enqueue(outgoing))
          },
        }),
      )

      // 手写流而不是用 `pipeUIMessageStreamToResponse`：要自己控制"什么时候结束响应"——
      // **收尾（终态 / 消耗 / 统计）落库之后才发 `RUN_FINISHED`**，于是客户端看到它
      // 就代表服务端已经落好终态（否则会出现"收到结束帧但查运行还是 running"的窗口）。
      response.writeHead(200, UI_STREAM_HEADERS)
      response.flushHeaders?.()
      streamStarted = true
      // 客户端断开是常态（刷新 / 换网络 / 关标签页）：不要让 socket 的 error 事件
      // 变成进程级未捕获异常（那会 `process.exit(1)`，把其它会话也一起带走）
      response.on?.('error', () => undefined)

      // 先把"这一轮的身份"发给客户端：**前端要靠它记住 runId**（停止与断线重连都只认 runId）。
      // 它走与业务片段**同一条记录 + 广播通道**，所以补发连接也一定会先拿到它。
      const runHead = {
        type: 'data-run',
        data: {
          runId: run.id,
          conversationId: conversation.id,
          agentKey: definition.key,
        },
      }
      pump.rev = await this.agui.emit({
        runId: run.id,
        threadId: conversation.id,
        chunk: runHead,
        response,
        messageIdRef,
      })

      const reader = recorded.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        // 客户端断开后**继续读**：这一轮的内容仍要落库 / 落 Redis，
        // 用户重新接回来（resume）时才能补发 —— 不能因为一次断线就把整轮丢掉。
        //
        // 响应体**不再承载业务内容**（main 只 `drain` 它，内容一律走定向广播）：
        // 逐 chunk 再序列化一遍是纯粹的写放大，早先每个 token 都要付一次。
        // 这个循环仍然必须读：它是驱动上面 transform（录制 + 发射）的泵。
        if (value.type === 'data-tool-call-suspended') {
          // 挂起事件到了就主动收流：Mastra 的挂起流不会再自己结束（它在等 resume），
          // 继续 read 会一直挂着，会话永远不释放。cancel 上游，下面按 suspended 收尾。
          // 不 cancel 上游：挂起后 Mastra 还要把嵌套 workflow 的快照补完整；
          // 直接断读会让 resume 拿到缺了嵌套 step input 的快照。
          break
        }
      }

      // 被中止时 Mastra 会**正常返回**（流被截断但不抛错）→ 必须自己判定"这不是成功，是取消"
      if (abort.signal.aborted) {
        await recorder.flushPending()
        // 首 token 超时也走 abort，但语义是"失败"不是"用户取消"（收尾分支据此分流）
        throw new Error(watchdog.timedOut ? 'first_token_timeout' : 'stream_aborted_by_user')
      }
      // 收尾前把没有 text-end 的残余内容也落库（防御性：正常结束一般不会有）
      await recorder.flushPending()

      /**
       * 工具挂起（`ask-user-questions`）：这一轮**没有结束**，只是停在等用户回答。
       *
       * 不能走下面的 `finish(Succeeded)`；否则会话被释放、快照被当成"已完成"，
       * 用户回答时没有可续跑的 run。这里把状态落成 `suspended`，保住 `engine_run_id` 与 Mastra 快照，
       * 回答时走 `/agent/chat/resume` 从同一条 run 继续。
       */
      if (pump.suspended) {
        const suspendSteps = (await readStreamSteps(output)) as unknown as StepLike[]
        const persistedSuspend = await recorder.finish(suspendSteps)
        await finishSuspendedTurn(
          {
            runs: this.runs,
            logger: this.logger,
            agui: this.agui,
            approvalPort: this.approvalPort ?? null,
            telemetry: this.engineTelemetry ?? null,
          },
          {
            runId: run.id,
            conversationId: conversation.id,
            usage: await rollUpUsage(
              this.runs,
              run.id,
              toUsageRecord(await readStreamUsage(output)),
            ),
            stepCount: suspendSteps.length,
            toolCallCount: persistedSuspend.toolCallCount,
            durationMs: Date.now() - startedAt,
            response,
            messageIdRef,
            finishStream: true,
            logEvent: 'ai.stream.suspended',
          },
        )
        watchdog.stop()
        return
      }

      // 收尾：**先 Postgres 终态，再清 Redis 进度**（反过来会留下"没进度也没结果"的窗口）
      // 步骤 / 用量一律走 stream-result 的读取口径：`agent.stream()` 在**可恢复执行（durable）**下
      // 返回的是包装对象（`{ output, fullStream, … }`），真正的 `MastraModelOutput` 在 `output` 里 ——
      // 直接读 `output.steps` 会拿到 undefined（踩过的崩点，见 stream-result.ts 的注释）
      const steps = (await readStreamSteps(output)) as unknown as StepLike[]
      const persisted = await recorder.finish(steps)
      // 记忆抽取仍在收尾（要读完整一轮）；命名已与主回答并行跑完，这里只等它并账
      const extracted = await this.extractMemory({
        conversationId: conversation.id,
        runId: run.id,
        userId,
        agentKey: definition.key,
        userMessage: input.message,
        turnCount: conversation.turnCount,
        model,
      })
      const title = await titlePromise
      const usageBase = await rollUpUsage(
        this.runs,
        run.id,
        toUsageRecord(await readStreamUsage(output)),
      )
      // 并账要**保留 usageBase 里的非 token 字段**（如 `subAgents`）：
      // `mergeUsage` 只逐字段加 token，直接把它的结果当 usage 会把那些字段抹掉（踩过：子 agent 明细消失）
      // 并账：命名 + 记忆抽取的用量都要进这一轮的账（mergeUsage 只加 token，非 token 字段要保留）
      let usage = usageBase
      for (const extra of [title?.usage, extracted?.usage]) {
        if (extra) usage = { ...usage, ...mergeUsage(usage, extra) }
      }
      const durationMs = Date.now() - startedAt
      await finishSucceededTurn(
        {
          runs: this.runs,
          conversations: this.conversationRepo,
          logger: this.logger,
          emitUsage: (chunk) =>
            this.agui.emit({
              runId: run.id,
              threadId: conversation.id,
              chunk,
              response,
              messageIdRef,
            }),
        },
        {
          runId: run.id,
          conversationId: conversation.id,
          usage,
          stepCount: steps.length,
          toolCallCount: persisted.toolCallCount,
          durationMs,
          firstTokenMs:
            recorder.firstOutputAtMs === null ? null : recorder.firstOutputAtMs - startedAt,
          logEvent: 'ai.stream.succeeded',
        },
      )

      // 终态已落库 → 先停心跳，再告诉客户端"这一轮结束"：
      // 顺序反了会留出"response 已 end、定时器又写一帧"的窗口（正是进程被杀的那个 bug）
      watchdog.stop()
      await this.agui.finish(response, run.id, conversation.id)
    } catch (error) {
      const durationMs = Date.now() - startedAt
      const reason = error instanceof Error ? error.message : String(error)
      const timedOut = watchdog.timedOut
      const canceled = !timedOut && abort.signal.aborted
      const mapped = timedOut
        ? new ModelNoResponseError(this.config.firstTokenTimeoutMs)
        : canceled
          ? null
          : classifyModelError(error)
      await finishFailedTurn(
        {
          runs: this.runs,
          timelines: this.timelines,
          logger: this.logger,
          cascadeStop: (runId, conversationId) => this.cascadeStop(runId, conversationId),
          writeFallbackTitle: () => writeFallbackTitle(this.titleDeps, conversation, input.message),
        },
        {
          kind: timedOut ? 'timeout' : canceled ? 'canceled' : 'failed',
          runId: run.id,
          conversationId: conversation.id,
          durationMs,
          reason,
          ...(timedOut ? { timeoutMs: this.config.firstTokenTimeoutMs } : {}),
          ...(canceled ? { operator: userId } : {}),
          ...(mapped ? { mapped } : {}),
          logEvent: timedOut
            ? 'ai.stream.first_token_timeout'
            : canceled
              ? 'ai.stream.canceled'
              : 'ai.stream.failed',
          writeTitle: true,
          clearActiveStream: true,
        },
      )

      /**
       * 响应头还没发 → 这一轮**根本没建流**（模型解析 / 附件读取 / 上下文组装失败）。
       * 此时必须把真实错误**抛回 HTTP 层**：控制器会把 3406 / 3311 这类具体错误码
       * 原样返回，前端 `onError` 能显示"去后台配模型"这种可行动的原因。
       * 若在这里吞掉并写一个结束帧，客户端只会看到"空回答"，而错误码永远传不出去。
       */
      if (!streamStarted) {
        throw mapped ?? error
      }

      // 失败也要给客户端一个明确收尾（错误本身已随 error chunk 下发）
      await this.agui.finish(response, run.id, conversation.id)
    } finally {
      watchdog.stop()
      try {
        if (unsubscribeStop) unsubscribeStop()
      } catch (error) {
        // 取消订阅失败无碍：那条订阅连接会随进程 / Redis 自然回收
        this.logger.warn('ai.stream.unsubscribe_failed', {
          runId: run.id,
          reason: error instanceof Error ? error.message : String(error),
        })
      }
      this.activeRuns.delete(run.id)
      // 通知"还在补发中的重连连接"：本轮结束了（同一条流协议里的结束标记）
      try {
        if (streamStarted && !response.writableEnded) {
          await this.agui.emit({
            runId: run.id,
            threadId: conversation.id,
            chunk: { type: STREAM_END_MARKER },
          })
        }
      } catch {
        // 广播失败无碍：补发连接会被客户端的 idle 处理或下一次刷新收敛
      }
      // 冲掉残余增量并停表：必须在 `clearRun` 之前（进度键没了，广播就找不到收件人）
      try {
        await this.agui.dispose(run.id)
      } catch {
        // 合并器收尾失败只影响最后 ≤100ms 的增量，时间线里已有已闭合内容
      }
      try {
        await this.streams.clearRun(run.id)
      } catch {
        // Redis 短暂不可用不改变终态：看门狗以 Postgres 的心跳为准
      }
      // 只有"确实建过流"才由这里收尾响应；没建流时留给 HTTP 错误处理器写 JSON 信封
      if (streamStarted) endSse(response)
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
    clientId?: string,
    onRunCreated?: (run: { id: string; conversationId: string; taskId: string | null }) => void,
  ): Promise<void> {
    const mastra = this.requireMastra()
    const run = await this.runs.findEntity(input.runId)
    if (!run) throw new RunNotFoundError(input.runId)
    const conversation = await this.conversations.requireOwned(userId, run.conversationId)
    if (run.status !== RunStatus.Suspended || !run.engineRunId) {
      throw new RunNotSuspendedError(run.id)
    }
    onRunCreated?.({ id: run.id, conversationId: conversation.id, taskId: run.taskId })
    if (clientId) await this.streams.bindClient(run.id, clientId)

    /** 取消整组回答：不带答案，只把"用户取消"这个结论交回工具 */
    const cancelled = input.cancelled === true
    const answers = input.answers ?? []
    await this.approvalPort?.resume({
      runId: run.id,
      cancelled,
      answerCount: answers.length,
    })
    const definition = this.registry.resolve(conversation.agentKey)
    const startedAt = Date.now()
    const abort = new AbortController()
    this.activeRuns.set(run.id, abort)

    let streamStarted = false
    /** 看护：心跳续租（写 SSE 注释帧）+ 首 token 超时（与 chatStream 同一口径） */
    const watchdog = new TurnWatchdog({
      runs: this.runs,
      runId: run.id,
      firstTokenTimeoutMs: this.config.firstTokenTimeoutMs,
      startedAt,
      onHeartbeat: () => {
        if (streamStarted) writeSse(response, ': ping\n\n')
      },
      onTimeout: () => abort.abort(),
      onFirstToken: (elapsedMs) => this.engineTelemetry?.firstToken(elapsedMs),
    })

    try {
      const model = await this.resolveRuntimeModel(definition, undefined, {
        runId: run.id,
        conversationId: conversation.id,
        identityType: isAdmin ? 'admin' : 'user',
        identityId: userId,
      })
      const modelInstance = await this.resolveModelInstance(model)

      // 挂起期间状态是 suspended；续跑开始先回到 running（占用会话，防止同会话另一轮插进来）
      await this.runs.markRunning(run.id, run.engineRunId)
      /**
       * 续跑也必须登记 Redis 输出记录：否则客户端断开 / 刷新后 `/agent/run/stream`
       * 找不到进度键，只能回 204 —— 服务端还在跑，页面却显示空闲。
       */
      const streamId = `${run.id}-${Date.now()}-resume`
      await this.runs.setActiveStream(run.id, streamId)
      await this.streams.startRun(run.id, {
        status: RunStatus.Running,
        stage: 'generating',
        streamId,
        rev: 0,
        step: 0,
      })

      const requestContext = await buildRuntimeContext(
        this.runtimeContextDeps,
        conversation.id,
        run.id,
        definition,
        userId,
        model,
        {
          ...(run.taskId ? { taskId: run.taskId } : {}),
          fileAccess: conversation.fileAccess,
          workspaceConversationId: conversation.rootConversationId ?? conversation.id,
          ...(conversation.workspaceId ? { workspaceId: conversation.workspaceId } : {}),
          abortSignal: abort.signal,
          systemPrompt: await resolveSystemPrompt(
            this.runtimeContextDeps,
            conversation,
            run.id,
            definition,
            userId,
            isAdmin,
          ),
          // 续跑与首轮同一身份口径：admin 的 skill-* 工具不能因为"续跑"而消失
          isAdmin,
        },
      )
      const agent = mastra.getAgent(definition.key)
      const memoryThread = await this.ensureAgentThread(conversation.id, userId)
      await this.rehydrateThreadIfEmpty(conversation.id, userId)
      /**
       * 轮内预算按**这一轮的窗口**算：优先用首轮落库的上下文快照（同一份判定），
       * 快照没有（旧数据）就现场解析一次。续跑的步数通常不多，但"套用首轮口径"
       * 能让同一条 run 的两段用同一个预算，不出现第二段突然收紧。
       */
      const windowTokens =
        (run.requestSnapshot?.context as { windowTokens?: number } | undefined)?.windowTokens ??
        this.context.resolveWindow(model.modelRef).windowTokens
      const runOptions = {
        runId: run.engineRunId,
        // 与 chatStream 同一口径：续跑必须给足步数。
        // 不传时 Mastra 默认 maxSteps=5 —— 续跑会在第 5 步悄悄结束，
        // 表现为"壳体建完就断了，要用户再发一句继续"（会话 rfitk3uq... 实测）。
        maxSteps: AGENT_MAX_STEPS,
        // 续跑后的下一段同样可能派子 agent：并发策略与主路径一致
        toolCallConcurrency: AGENT_TOOL_CONCURRENCY,
        requestContext,
        model: modelInstance.mastraInstance as never,
        abortSignal: abort.signal,
        memory: { ...memoryThread, options: memoryHistoryOptions(windowTokens) },
        savePerStep: true,
        // 轮内预算：与首轮同一口径
        prepareStep: this.buildPrepareStep(windowTokens),
      }
      watchdog.armFirstToken()
      const resumeOutput = await agent.resumeStream(cancelled ? { cancelled: true } : { answers }, {
        ...runOptions,
        ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
      })

      response.writeHead(200, UI_STREAM_HEADERS)
      streamStarted = true
      watchdog.startHeartbeat()

      const recorder = new StreamRecorder(
        this.timelines,
        { conversationId: conversation.id, runId: run.id },
        {
          metas: this.toolMetas,
          isKnownTool: this.isKnownToolKey,
        },
      )

      /**
       * 续跑也要**实时用量**：接上挂起前已经记下的用量 / 步数 / 耗时，
       * 于是恢复后的第一份 `data-step-usage` 是"这一轮到目前为止"的累计，而不是从 0 重数。
       * 两段流（恢复工具 + 继续 loop 的新引擎 run）共用同一个计数器。
       */
      const liveUsage = createLiveUsage({
        runId: run.id,
        startedAt,
        baseUsage: (run.usage ?? null) as Record<string, unknown> | null,
        baseSteps: run.stepCount ?? 0,
        baseDurationMs: run.durationMs ?? 0,
      })

      let suspendedAgain = false
      const messageIdRef: { value: string } = { value: '' }
      const consume = async (stream: unknown): Promise<void> => {
        const reader = (
          liveUsage.wrap(stream) as unknown as ReadableStream<UiChunkLike>
        ).getReader()
        for (;;) {
          const next = await reader.read()
          if (next.done) break
          const chunk = next.value
          // `data-tool-call-suspended` 有两种：新的挂起（resumed=false）和续跑成功
          // （resumed=true）。后者只是同一个工具从挂起点继续，不能当成"又问了下一个问题"。
          const resumedEvent =
            chunk.type === 'data-tool-call-suspended' &&
            (chunk as { data?: { resumed?: boolean } }).data?.resumed === true
          if (chunk.type === 'data-tool-call-suspended' && !resumedEvent) suspendedAgain = true
          if (
            chunk.type === 'text-delta' ||
            chunk.type === 'reasoning-delta' ||
            chunk.type === 'tool-input-available'
          ) {
            watchdog.markFirstTokenSeen()
          }
          const recordedChunk = normalizeSuspendedChunk(chunk, run.id)
          const outgoing = toClientToolChunk(recordedChunk)
          await this.agui.emit({
            runId: run.id,
            threadId: conversation.id,
            chunk: outgoing,
            response,
            messageIdRef,
          })
          await recorder.consume(recordedChunk)
          if (suspendedAgain) break
        }
      }

      await consume(resumeOutput)
      /**
       * 挂起工具的"结果"由我们补一条时间线：Mastra 的 resume 流只发
       * `tool-call-resumed`，不会把 ask-user-questions 的出参再发一遍。
       * 没有这行，历史重建会把已回答的问题卡又当成待回答显示出来。
       */
      if (input.toolCallId) {
        const existing = await this.timelines.findToolOutput(conversation.id, input.toolCallId)
        if (existing === null) {
          await this.timelines.append({
            conversationId: conversation.id,
            runId: run.id,
            role: TimelineRole.Assistant,
            kind: TimelineKind.ToolResult,
            toolKey: 'ask-user-questions',
            toolCallId: input.toolCallId,
            payload: {
              output: cancelled ? { cancelled: true, answers: [] } : { answers },
            },
          })
        }
      }
      // resume 只恢复了工具；要继续 agentic loop，再起一段**新引擎 run**，
      // 复用同一个 memory thread。旧 engine run 已经结束，拿它调 stream 不会发起模型调用。
      // 旧引擎 run 可能还占着 agent 的 active stream 槽位；先放掉，否则新 stream 不发起模型调用。
      //
      // **只在这次续跑不会再挂起时才放**：`abortRunStream` 内部是
      // `abortRun(runId, pubsub, { fenceResume = true })`，语义是"abort 发生在挂起期间 →
      // 这个 suspension 永远不能恢复"（`resumeStream` 入口 `#throwIfRunAborted` 会直接抛）。
      // 续跑又挂了下一个问题时这条 engine run 仍是「可恢复的挂起点」，放掉就等于把
      // 第二次回答判死（run 标 failed 3302，用户再提交得 409）—— 会话 rj7w3stssee4eh2urzia 实测。
      // 「释放流槽位」与「放弃可恢复性」在 Mastra 里是两个操作，这里只在前者成立时才做。
      if (!suspendedAgain) agent.abortRunStream?.(run.engineRunId)
      const { runId: _finishedEngineRunId, ...continuationOptions } = runOptions
      const answerText = answers
        .map(
          (answer) =>
            `- ${answer.id}: ${Array.isArray(answer.value) ? answer.value.join('、') : answer.value}`,
        )
        .join('\n')
      const continuationMessage = cancelled
        ? '用户取消了这组问题的回答（选择不回答）。不要再重复提问；请基于已有信息继续推进，确实缺少关键信息时说明影响并给出可执行的下一步。'
        : `用户已回答：\n${answerText}\n\n请基于这些回答继续。`
      const output = suspendedAgain
        ? resumeOutput
        : await agent.stream([{ role: 'user', content: continuationMessage }], continuationOptions)
      if (!suspendedAgain) {
        const nextEngineRunId = (output as { runId?: string }).runId
        if (nextEngineRunId) await this.runs.attachEngineRun(run.id, nextEngineRunId)
        await consume(output)
      }
      await recorder.flushPending()

      const steps = (await readStreamSteps(output)) as unknown as StepLike[]
      const persisted = await recorder.finish(steps)
      const priorUsage = (run.usage ?? null) as Record<string, unknown> | null
      const resumedUsage = await rollUpUsage(
        this.runs,
        run.id,
        toUsageRecord(await readStreamUsage(output)),
      )
      const usage = priorUsage
        ? (mergeUsage(priorUsage, resumedUsage) ?? resumedUsage)
        : resumedUsage

      // 续跑后模型又问了下一个问题：仍然停在 suspended，不能当成成功。
      if (suspendedAgain) {
        await finishSuspendedTurn(
          {
            runs: this.runs,
            streams: this.streams,
            logger: this.logger,
            agui: this.agui,
            approvalPort: this.approvalPort ?? null,
            telemetry: this.engineTelemetry ?? null,
          },
          {
            runId: run.id,
            conversationId: conversation.id,
            usage,
            stepCount: (run.stepCount ?? 0) + steps.length,
            toolCallCount: (run.toolCallCount ?? 0) + persisted.toolCallCount,
            durationMs: (run.durationMs ?? 0) + (Date.now() - startedAt),
            response,
            finishStream: true,
            // 前端已从工具挂起块知道"又挂起了"，不再重复发 data-run-suspended
            emitEvent: false,
            clearRun: true,
            logEvent: 'ai.stream.resumed_suspended',
          },
        )
        watchdog.stop()
        return
      }
      await finishSucceededTurn(
        {
          runs: this.runs,
          conversations: this.conversationRepo,
          logger: this.logger,
          streams: this.streams,
          emitUsage: (chunk) =>
            this.agui.emit({
              runId: run.id,
              threadId: conversation.id,
              chunk,
              response,
              messageIdRef,
            }),
        },
        {
          runId: run.id,
          conversationId: conversation.id,
          usage,
          stepCount: (run.stepCount ?? 0) + steps.length,
          toolCallCount: (run.toolCallCount ?? 0) + persisted.toolCallCount,
          durationMs: (run.durationMs ?? 0) + (Date.now() - startedAt),
          firstTokenMs: null,
          logEvent: 'ai.stream.resumed',
          logFields: { stepCount: steps.length },
          clearRun: true,
        },
      )

      watchdog.stop()
      await this.agui.finish(response, run.id, conversation.id)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      if (watchdog.timedOut) {
        const mapped = new ModelNoResponseError(this.config.firstTokenTimeoutMs)
        await this.runs.finish(run.id, {
          status: RunStatus.Failed,
          usage: await rollUpUsage(this.runs, run.id, null),
          errorCode: String(AppErrorCodes.ModelNoResponse),
          errorStage: RunErrorStage.Model,
          errorMessage: mapped.message,
          errorDetail: { raw: reason, timeoutMs: this.config.firstTokenTimeoutMs },
          durationMs: Date.now() - startedAt,
        })
        this.logger.error('ai.stream.resume_first_token_timeout', {
          runId: run.id,
          timeoutMs: this.config.firstTokenTimeoutMs,
        })
      } else if (abort.signal.aborted) {
        await this.runs.finish(run.id, {
          status: RunStatus.Canceled,
          durationMs: Date.now() - startedAt,
        })
        this.logger.log('ai.stream.resume_canceled', { runId: run.id })
      } else {
        await this.runs.finish(run.id, {
          status: RunStatus.Failed,
          usage: await rollUpUsage(this.runs, run.id, null),
          errorCode: String(AppErrorCodes.AgentFailed),
          errorStage: RunErrorStage.Model,
          errorMessage: reason,
          durationMs: Date.now() - startedAt,
        })
        this.logger.error('ai.stream.resume_failed', { runId: run.id, reason })
      }
      await this.runs.setActiveStream(run.id, null)
      await this.streams.clearRun(run.id)
      if (!streamStarted) throw error
      await this.agui.finish(response, run.id, conversation.id)
    } finally {
      watchdog.stop()
      this.activeRuns.delete(run.id)
      // 冲掉残余增量再关响应（否则最后 ≤100ms 的正文会随连接一起丢）
      try {
        await this.agui.dispose(run.id)
      } catch {
        // 合并器收尾失败只影响最后一段增量，已闭合内容都在时间线里
      }
      if (streamStarted) endSse(response)
    }
  }

  /**
   * 停止某一轮：本进程直接 abort；不在本进程则广播（跨副本）。
   *
   * `runId` 与 `conversationId` 至少给一个：前端刷新 / 换设备后 `runId` 可能丢了，
   * 但「用户点了停止」必须生效 —— 按会话找当前进行中的那一轮兜底。
   */
  async stopRun(
    userId: string,
    input: string | { runId?: string; conversationId?: string },
  ): Promise<AgentRunStopResultModel> {
    // 兼容旧调用（直接传 runId 字符串）：内部 HTTP 已统一传对象
    const request = typeof input === 'string' ? { runId: input } : input
    const run = request.runId
      ? await this.runs.findEntity(request.runId)
      : request.conversationId
        ? await this.runs.findActive(request.conversationId)
        : null
    // 精确 runId 找不到：旧语义保留（调用方传错了）；按会话找不到：没有可停的轮，幂等成功
    if (!run) {
      if (request.runId) throw new RunNotFoundError(request.runId)
      return { stopped: true, injected: 'local' }
    }
    const runId = run.id
    await this.conversations.requireOwned(userId, run.conversationId)

    // 挂起中的一轮没有"本进程里的流"可 abort：直接把状态落成 canceled，释放会话。
    // 不处理的话，用户想放弃这一轮只能一直卡在 3306（该会话已有进行中的对话）。
    if (run.status === RunStatus.Suspended) {
      await this.runs.finish(run.id, {
        status: RunStatus.Canceled,
        ...(run.durationMs != null ? { durationMs: run.durationMs } : {}),
      })
      await this.cascadeStop(run.id, run.conversationId)
      return { stopped: true, injected: 'local' }
    }

    const controller = this.activeRuns.get(runId)
    if (controller) {
      controller.abort()
      // abort 后的收尾也会再级联一次（幂等）；这里先取消，避免"停止接口返回了、子还在跑"
      await this.cascadeStop(run.id, run.conversationId)
      return { stopped: true, injected: 'local' }
    }
    await this.streams.publishStop(runId)
    await this.cascadeStop(run.id, run.conversationId)
    return { stopped: true, injected: 'broadcast' }
  }

  /**
   * 断线重连（**不报 runId 的版本**，`GET /agent/run/stream?sinceRev=N`）：
   *
   * 页面刷新 / 换设备后，前端并不知道 runId（它只在流里的 `RUN_STARTED` 里给过一次）。
   * 与其让前端把它存进 localStorage（换设备就丢），不如按**登录用户**在库里找"当前进行中的那一轮"
   * —— 真相在 Postgres，浏览器只是个显示器。
   *
   * 传了 `conversationId` 就**只在该会话内**找（会话页必须传：否则切到已结束的会话时，
   * 会把另一个会话正在跑的流接进来）；不传则回退按用户找 —— 兼容还没有会话上下文的旧调用。
   *
   * 返回 false 表示当前没有进行中的运行 → 控制器回 204（客户端静默收尾）。
   */
  async resumeCurrentRun(
    userId: string,
    sinceRev: number | undefined,
    response: StreamResponseLike,
    conversationId?: string,
    clientId?: string,
  ): Promise<boolean> {
    const active = conversationId
      ? await this.runs.findActiveByConversation(userId, conversationId)
      : await this.runs.findActiveByUser(userId)
    if (!active) return false
    return this.resumeRun(userId, active.id, sinceRev, response, clientId)
  }

  /**
   * 断线重连（`GET /agent/run/:runId/stream?sinceRev=N`）：
   *
   * **不再整轮重放**（手册 §6）。两条腿：
   * - 快照：`buildRunSnapshot` 只给"已闭合 part"，合并成少量重放块；
   * - 增量：从 `sinceRev`（含）开始，先按 chunk 口径整形（回退到块开头 / 丢孤立 end /
   *   合并相邻增量），再编回 AG-UI 事件。
   *
   * 补发走**一次 pipeline**（1.5 万帧 ~3s → ~56ms），且与实时事件走同一条定向频道；
   * 本请求只发、不订阅（订阅自己会自激，2026-11-15 OOM 的根因）。
   *
   * 返回 false 表示"没有进行中的流" → 控制器回 204。
   */
  async resumeRun(
    userId: string,
    runId: string,
    sinceRev: number | undefined,
    response: StreamResponseLike,
    clientId?: string,
  ): Promise<boolean> {
    const run = await this.runs.findEntity(runId)
    if (!run) throw new RunNotFoundError(runId)
    // 归属校验（失败抛错）；补发本身不读会话内容
    await this.conversations.requireOwned(userId, run.conversationId)
    if (clientId) await this.streams.bindClient(run.id, clientId)

    /**
     * **Postgres 终态优先于 Redis 进度**：进程崩溃时旧进程没来得及删进度键
     * （TTL 6h），启动清理把 run 标成 `interrupted` 后，Redis 里可能仍写着 `running`。
     * 只看 Redis 会让客户端"接回"一条永远不会有新事件的死流（挂到超时）。
     */
    if (run.status !== RunStatus.Running && run.status !== RunStatus.Pending) {
      return false
    }

    const progress = await this.streams.readRun(runId)
    if (!progress || progress.status !== RunStatus.Running) return false

    response.writeHead(200, UI_STREAM_HEADERS)
    response.flushHeaders?.()
    // 断线后的补发连接同样可能随时消失：socket 的 error 事件不能变成进程级未捕获异常
    response.on?.('error', () => undefined)

    // 先合闸门再读记录：顺序反了，读快照到合闸门之间的实时事件会插到重放前面
    const replayStartedAt = Date.now()
    await this.streams.beginReplay(runId)
    try {
      const replayed = await this.replayRun(run, sinceRev, response)
      this.engineTelemetry?.replay(Date.now() - replayStartedAt, replayed)
      return replayed
    } finally {
      await this.streams.endReplay(runId)
    }
  }

  /** 正在跑的那一轮的已闭合内容快照（RunExecutor / controller 用） */
  async snapshotRun(userId: string, runId: string) {
    return snapshotRun(this.snapshotDeps, userId, runId)
  }

  async snapshotCurrentRun(userId: string, conversationId?: string) {
    return snapshotCurrentRun(this.snapshotDeps, userId, conversationId)
  }

  /** 补发主体（闸门内执行；只发不订阅） */
  private async replayRun(
    run: { id: string; conversationId: string },
    sinceRev: number | undefined,
    response: StreamResponseLike,
  ): Promise<boolean> {
    const [snapshotData, records] = await Promise.all([
      loadSnapshotData(this.snapshotDeps, run.id),
      this.streams.readAllEvents(run.id),
    ])
    /**
     * 未裁剪时优先用**事件记录**归约：它能保留 part 的原始 id，同一页面重连时前端按 id
     * 原地更新；裁剪后才改用时间线快照（原始 id 已经丢了，只能按位置合成）。
     */
    const trimmed = (records[0]?.rev ?? 1) > 1
    const { snapshot, replayChunks } = buildRunSnapshot(run.id, records, {
      ...(snapshotData.messageId ? { messageId: snapshotData.messageId } : {}),
      ...(trimmed && snapshotData.parts ? { parts: snapshotData.parts } : {}),
    })

    /**
     * 客户端没报 `sinceRev`（刷新 / 换设备）→ 先给快照再给增量；
     * 报了（例如浏览器自己接着上次的 rev）→ 只补之后的，避免重复。
     */
    const includeSnapshot = sinceRev === undefined || sinceRev <= 0
    const from = includeSnapshot ? snapshot.sinceRev : Math.max(0, Math.floor(sinceRev))
    const tail = records.filter((record) => record.rev >= from)
    /**
     * 正常情况按 `sinceRev` 切片；被裁剪时 `sinceRev` 已经不可信，只补**仍未闭合 part**
     * 的增量（已闭合内容全部在时间线快照里，不能再发一遍）。
     */
    const tailChunks = trimmed
      ? openPartChunks(records)
      : decodeRecords(tail).map((record) => record.chunk)
    const compacted = coalesceDeltas(resumeSafeChunks(tailChunks, 0))

    const ctx = { threadId: run.conversationId, runId: run.id }
    const events: unknown[] = []
    /**
     * **首帧是 `RUN_STARTED`**（手册 §8 坑 11）：客户端据此建运行、拿 runId。
     *
     * `start`（消息身份）紧随其后。前端恢复链路（`useRunRecovery`）已经用快照的
     * `messageId` 建好种子消息，同 id 的 `start` 不会重置 parts —— 所以这里不必再
     * 为旧版 `useChat({ resume: true })` 把 `start` 放到最前面。
     */
    events.push(
      ...encodeAgUiChunk(
        {
          type: 'data-run',
          data: { runId: run.id, conversationId: run.conversationId },
        },
        ctx,
      ),
    )
    events.push(...encodeAgUiChunk({ type: 'start', messageId: snapshot.messageId }, ctx))
    for (const chunk of includeSnapshot ? replayChunks : []) {
      events.push(...encodeAgUiChunk(chunk as AgUiChunk, ctx))
    }
    for (const chunk of compacted) {
      const encoded = encodeAgUiChunk(chunk as AgUiChunk, ctx)
      events.push(...encoded)
      // 结束帧后面的内容不再补：客户端看到 RUN_FINISHED 就收尾了
      if (encoded.some((event) => isRunFinalEvent(event))) break
    }
    /**
     * 解码后的 `finish` 会被编码成 RAW（它也可能只是"模型这一条消息说完了"），
     * 所以运行边界要看**记录里的事件类型**，单独补一帧 `RUN_FINISHED`。
     */
    const endsHere =
      (records.at(-1)?.event as { type?: string } | null | undefined)?.type === 'RUN_FINISHED'
    const lastType = (events.at(-1) as { type?: string } | undefined)?.type
    if (endsHere && lastType !== 'RUN_FINISHED') {
      events.push(...encodeAgUiChunk({ type: '__run_end__' }, ctx))
    }

    await this.streams.publishEvents(run.id, events)
    // 实时事件继续由「跑 run 的那一侧」发给**新**绑定的 clientId：重连时 `bindClient` 已经把
    // 地址改成新的（存在 Redis 的进度 Hash 里，跨副本也读得到），所以补发完就能收尾。
    endSse(response)
    return true
  }

  /**
   * 队列项 → 真正的一轮（`dispatcher` 的唯一入口）。
   *
   * 两种来源：
   * - `user`：会话忙时排队的用户消息（时间线照常先写用户消息）；
   * - `subagent`：子 agent 完成唤醒（**不写用户消息**；先写系统卡，模型输入收尾是内部 system 通知）。
   *
   * 创建 run 是同步的（调用方要立刻拿到 runId 落 `queue.run_id`），之后的无头执行在后台跑，
   * 结果通过 `done` 返回：`succeeded/failed/canceled`。执行内部**不抛业务错**，失败已落 `runs`。
   */
  async startQueuedTurn(
    item: ConversationRunQueueEntity,
    claim?: (runId: string) => Promise<boolean>,
  ): Promise<{
    runId: string
    done: Promise<'succeeded' | 'failed' | 'canceled'>
  } | null> {
    const conversation = await this.conversationRepo.findEntity(item.conversationId)
    if (!conversation) throw new Error('会话不存在或已删除，队列项不再执行')
    const payload = asRecord(item.payload)
    if (!payload) throw new Error('队列项 payload 不是对象，无法调度')
    // 与 `chatStream` 同一口径：排队消息带 agentKey 时以它为准，否则用会话上的 agent
    const definition = this.registry.resolve(
      item.source === 'user'
        ? (asText(payload.agentKey) ?? conversation.agentKey)
        : conversation.agentKey,
    )
    const queue = { id: item.id, source: item.source, dedupeKey: item.dedupeKey }

    /**
     * 队列项抢到才允许起跑：`claim` 是 `dispatching -> started` 的条件 UPDATE。
     * 抢不到（已被删会话 / 取消 / 换手）时，这一行 pending run 必须立刻取消 ——
     * 否则会留下一条永远"在进行中"的审计记录，并占住会话的活动 run 唯一索引。
     */
    const claimRun = async (run: {
      id: string
      engineRunId: string
      taskId: string | null
    }): Promise<boolean> => {
      if (!claim) return true
      try {
        if (await claim(run.id)) return true
      } catch (error) {
        await this.runs.finish(run.id, { status: RunStatus.Canceled }).catch(() => undefined)
        throw error
      }
      await this.runs.finish(run.id, { status: RunStatus.Canceled })
      return false
    }

    if (item.source === 'subagent') {
      const wake = toSubAgentWake(payload)
      if (!wake) throw new Error('子 agent 唤醒 payload 缺少 subAgentId / subRunId / name')
      const run = await this.startRun(
        conversation,
        definition.key,
        conversation.userId,
        'subagent',
        { deferStart: true },
      )
      if (!(await claimRun(run))) return null
      await this.runs.markRunning(run.id, run.engineRunId)
      const done = this.executeQueuedTurn({
        run,
        conversation,
        definition,
        userId: conversation.userId,
        isAdmin: payload.isAdmin === true,
        origin: 'subagent',
        message: wakeNoticeText(wake),
        internalNotice: wakeNoticeText(wake),
        card: wakeCard(wake),
        queue,
      })
      return { runId: run.id, done }
    }

    const user = toQueuedUser(payload)
    if (!user) throw new Error('用户排队消息 payload 缺少 message')
    const run = await this.startRun(conversation, definition.key, conversation.userId, 'user', {
      deferStart: true,
      ...(user.requestId ? { requestId: user.requestId } : {}),
    })
    if (!(await claimRun(run))) return null
    await this.runs.markRunning(run.id, run.engineRunId)
    const done = this.executeQueuedTurn({
      run,
      conversation,
      definition,
      userId: conversation.userId,
      isAdmin: user.isAdmin,
      origin: 'user',
      message: user.message,
      ...(user.modelId ? { modelId: user.modelId } : {}),
      ...(user.attachments ? { attachments: user.attachments } : {}),
      card: null,
      queue,
    })
    return { runId: run.id, done }
  }

  /**
   * 无头执行一轮（没有 HTTP 响应）：所有内容只进**时间线 + Redis 输出记录 + 广播**。
   *
   * 与 {@link chatStream} 共用同一套模型解析 / 上下文组装 / 录制器 / 收尾与用量口径，
   * 区别只在"写给谁"：这里没有 `response`，前端靠 `conversation.run.started` 自动续流，
   * 断线重连走 `GET /agent/run/stream` 从输出记录补发。
   */
  private async executeQueuedTurn(input: {
    run: { id: string; engineRunId: string; taskId: string | null }
    conversation: ConversationEntity
    definition: AgentDefinition
    userId: string
    isAdmin: boolean
    origin: 'user' | 'subagent'
    message: string
    internalNotice?: string
    attachments?: readonly ChatAttachmentModel[]
    modelId?: string
    card: Record<string, unknown> | null
    queue: { id: string; source: string; dedupeKey: string | null }
  }): Promise<'succeeded' | 'failed' | 'canceled'> {
    const { run, conversation, definition, userId, origin } = input
    const startedAt = Date.now()
    const abort = new AbortController()
    this.activeRuns.set(run.id, abort)

    let unsubscribeStop: (() => void) | null = null
    /** 看护：心跳续租（无头路径额外写 Redis 进度心跳）+ 首 token 超时 */
    const watchdog = new TurnWatchdog({
      runs: this.runs,
      runId: run.id,
      firstTokenTimeoutMs: this.config.firstTokenTimeoutMs,
      startedAt,
      onHeartbeat: () => {
        void this.streams
          .patchRun(run.id, { heartbeatAt: new Date().toISOString() })
          .catch(() => undefined)
      },
      onTimeout: () => abort.abort(),
      onFirstToken: (elapsedMs) => this.engineTelemetry?.firstToken(elapsedMs),
    })

    /** 一个片段 → AG-UI 事件 → 输出记录 + 广播（断线重连按 rev 补发） */
    const messageIdRef: { value: string } = { value: '' }
    const emit = async (chunk: unknown): Promise<number> =>
      this.agui.emit({
        runId: run.id,
        threadId: conversation.id,
        chunk,
        messageIdRef,
      })

    try {
      // 排队过一段时间的用户消息也要登记 / 物化附件（与 `chatStream` 同一入口；失败不阻塞）
      if (origin === 'user' && input.attachments && input.attachments.length > 0) {
        await this.registerInboundFiles(conversation, run.id, userId, input.isAdmin, [
          ...input.attachments,
        ])
      }
      const dto = {
        message: input.message,
        ...(input.modelId ? { modelId: input.modelId } : {}),
        ...(input.attachments ? { attachments: [...input.attachments] } : {}),
      } as AgentChatDto
      const prepared = await prepareTurn(this.prepareDeps, {
        conversation,
        definition,
        run,
        userId: conversation.userId,
        isAdmin: input.isAdmin,
        input: dto,
        origin,
        abortSignal: abort.signal,
        writeUserMessage: origin === 'user',
        ...(input.internalNotice ? { internalNotice: input.internalNotice } : {}),
        snapshotExtra: {
          origin,
          queue: input.queue,
          ...(input.card ? { subAgent: input.card } : {}),
        },
        ...(input.card ? { card: input.card } : {}),
      })
      const { model, modelInstance, built, titlePromise } = prepared

      const streamId = `${run.id}-${Date.now()}-queue`
      await this.runs.setActiveStream(run.id, streamId)
      await this.streams.startRun(run.id, {
        status: RunStatus.Running,
        stage: 'generating',
        streamId,
        rev: 0,
        step: 0,
      })

      const recorder = new StreamRecorder(
        this.timelines,
        { conversationId: conversation.id, runId: run.id },
        {
          metas: this.toolMetas,
          isKnownTool: this.isKnownToolKey,
        },
      )
      const pump = new TurnChunkPump({
        runId: run.id,
        conversationId: conversation.id,
        recorder,
        agui: this.agui,
        streams: this.streams,
        runs: this.runs,
        logger: this.logger,
        messageIdRef,
        onFirstToken: () => watchdog.markFirstTokenSeen(),
      })
      watchdog.startHeartbeat()

      try {
        unsubscribeStop = await this.streams.subscribeStop(run.id, () => abort.abort())
      } catch (error) {
        this.logger.warn('ai.stream.stop_subscribe_failed', {
          runId: run.id,
          reason: error instanceof Error ? error.message : String(error),
        })
      }

      // 先把"这一轮的身份"写进输出记录：续流连接的第一块就能拿到 runId（含来源）
      await emit({
        type: 'data-run',
        data: {
          runId: run.id,
          conversationId: conversation.id,
          agentKey: definition.key,
          origin,
        },
      })
      if (input.card) {
        await emit({
          type: 'data-subagent-completed',
          id: String(input.card.subRunId ?? run.id),
          data: input.card,
        })
      }
      // 输出记录与进度已就绪 → 再通知"新的一轮开始了"：前端收到后立刻接流不会 204
      await this.notifyRunStarted(conversation.id, run.id, origin)

      const { requestContext, memoryThread } = await prepareRuntime(this.prepareDeps, {
        conversation,
        definition,
        run,
        userId: conversation.userId,
        isAdmin: input.isAdmin,
        model,
        origin,
        abortSignal: abort.signal,
      })
      const agent = this.requireMastra().getAgent(definition.key)

      watchdog.armFirstToken()
      const output = await agent.stream(built.messages as never, {
        maxSteps: AGENT_MAX_STEPS,
        toolCallConcurrency: AGENT_TOOL_CONCURRENCY,
        abortSignal: abort.signal,
        requestContext,
        memory: {
          ...memoryThread,
          options: memoryHistoryOptions(built.snapshot.windowTokens),
        },
        savePerStep: true,
        model: modelInstance.mastraInstance as never,
        runId: run.engineRunId,
        closeOnSuspend: true,
        prepareStep: this.buildPrepareStep(built.snapshot.windowTokens),
      })
      const uiStream = createLiveUsage({ runId: run.id, startedAt }).wrap(output)
      const reader = (uiStream as unknown as ReadableStream<UiChunkLike>).getReader()
      for (;;) {
        const next = await reader.read()
        if (next.done) break
        await pump.consume(next.value)
        if (pump.suspended) break
      }

      if (abort.signal.aborted) {
        await recorder.flushPending()
        throw new Error(watchdog.timedOut ? 'first_token_timeout' : 'stream_aborted_by_user')
      }
      await recorder.flushPending()

      if (pump.suspended) {
        const suspendSteps = (await readStreamSteps(output)) as unknown as StepLike[]
        const persistedSuspend = await recorder.finish(suspendSteps)
        await finishSuspendedTurn(
          {
            runs: this.runs,
            logger: this.logger,
            agui: this.agui,
            approvalPort: this.approvalPort ?? null,
            telemetry: this.engineTelemetry ?? null,
          },
          {
            runId: run.id,
            conversationId: conversation.id,
            usage: await rollUpUsage(
              this.runs,
              run.id,
              toUsageRecord(await readStreamUsage(output)),
            ),
            stepCount: suspendSteps.length,
            toolCallCount: persistedSuspend.toolCallCount,
            durationMs: Date.now() - startedAt,
            finishStream: false,
            logEvent: 'ai.stream.suspended',
            logFields: { origin },
          },
        )
        watchdog.stop()
        return 'succeeded'
      }

      const steps = (await readStreamSteps(output)) as unknown as StepLike[]
      const persisted = await recorder.finish(steps)
      // 记忆抽取只属于用户消息（子 agent 唤醒不是用户说的）；命名已与主回答并行跑完
      const extracted =
        origin === 'user'
          ? await this.extractMemory({
              conversationId: conversation.id,
              runId: run.id,
              userId,
              agentKey: definition.key,
              userMessage: input.message,
              turnCount: conversation.turnCount,
              model,
            })
          : null
      const title = await titlePromise
      const usageBase = await rollUpUsage(
        this.runs,
        run.id,
        toUsageRecord(await readStreamUsage(output)),
      )
      let usage = usageBase
      for (const extra of [title?.usage, extracted?.usage]) {
        if (extra) usage = { ...usage, ...mergeUsage(usage, extra) }
      }
      const durationMs = Date.now() - startedAt
      await finishSucceededTurn(
        {
          runs: this.runs,
          conversations: this.conversationRepo,
          logger: this.logger,
          emitUsage: emit,
        },
        {
          runId: run.id,
          conversationId: conversation.id,
          usage,
          stepCount: steps.length,
          toolCallCount: persisted.toolCallCount,
          durationMs,
          firstTokenMs:
            recorder.firstOutputAtMs === null ? null : recorder.firstOutputAtMs - startedAt,
          logEvent: 'ai.stream.queued_turn_succeeded',
          logFields: { origin },
        },
      )
      return 'succeeded'
    } catch (error) {
      const durationMs = Date.now() - startedAt
      const reason = error instanceof Error ? error.message : String(error)
      const timedOut = watchdog.timedOut
      const canceled = !timedOut && abort.signal.aborted
      const mapped = timedOut
        ? new ModelNoResponseError(this.config.firstTokenTimeoutMs)
        : canceled
          ? null
          : classifyModelError(error)
      return await finishFailedTurn(
        {
          runs: this.runs,
          timelines: this.timelines,
          logger: this.logger,
          cascadeStop: (runId, conversationId) => this.cascadeStop(runId, conversationId),
          writeFallbackTitle: () => writeFallbackTitle(this.titleDeps, conversation, input.message),
        },
        {
          kind: timedOut ? 'timeout' : canceled ? 'canceled' : 'failed',
          runId: run.id,
          conversationId: conversation.id,
          durationMs,
          reason,
          origin,
          ...(timedOut ? { timeoutMs: this.config.firstTokenTimeoutMs } : {}),
          ...(canceled ? { operator: userId } : {}),
          ...(mapped ? { mapped } : {}),
          logEvent: timedOut
            ? 'ai.stream.queued_turn_first_token_timeout'
            : canceled
              ? 'ai.stream.queued_turn_canceled'
              : 'ai.stream.queued_turn_failed',
          logFields: { origin },
          writeTitle: origin === 'user',
          clearActiveStream: false,
        },
      )
    } finally {
      watchdog.stop()
      watchdog.markFirstTokenSeen()
      try {
        if (unsubscribeStop) unsubscribeStop()
      } catch {
        // 取消订阅失败无碍：那条订阅连接会随进程 / Redis 自然回收
      }
      this.activeRuns.delete(run.id)
      try {
        await emit({ type: STREAM_END_MARKER })
      } catch {
        // 广播失败无碍：补发连接会被客户端的 idle 处理或下一次刷新收敛
      }
      // 冲掉残余增量再清进度键（清完 broadcast 就没有收件人了）
      try {
        await this.agui.dispose(run.id)
      } catch {
        // 合并器收尾失败只影响最后 ≤100ms 的增量，时间线里已有已闭合内容
      }
      try {
        await this.streams.clearRun(run.id)
      } catch {
        // Redis 短暂不可用不改变终态：看门狗以 Postgres 的心跳为准
      }
    }
  }

  /** 会话忙：把用户消息排进 `conversation_run_queue`（`source=user`，priority 0） */
  private async enqueueUserMessage(
    conversation: ConversationEntity,
    input: AgentChatDto,
    isAdmin: boolean,
  ): Promise<ConversationRunQueueEntity> {
    if (!this.runQueue) throw new ConversationBusyError(conversation.id)
    return this.runQueue.enqueue({
      conversationId: conversation.id,
      source: 'user',
      payload: {
        message: input.message,
        isAdmin,
        ...(this.requestIdOf(input) ? { requestId: this.requestIdOf(input) } : {}),
        ...(input.modelId ? { modelId: input.modelId } : {}),
        ...(input.agentKey ? { agentKey: input.agentKey } : {}),
        ...(input.fileAccess ? { fileAccess: input.fileAccess } : {}),
        ...(input.attachments ? { attachments: input.attachments } : {}),
      },
    })
  }

  /** 排队应答：一帧 `data-queue` + 正常收尾（前端据此提示"已排队"，并等 `conversation.run.started`） */
  private writeQueuedAck(
    response: StreamResponseLike,
    conversationId: string,
    item: ConversationRunQueueEntity,
    userId: string,
    clientId?: string,
  ): void {
    const chunk = {
      type: 'data-queue',
      data: {
        conversationId,
        queueId: item.id,
        queued: true,
        message: '上一轮还在跑，这条消息已排队；轮到时页面会自动继续',
      },
    }
    response.writeHead(200, UI_STREAM_HEADERS)
    response.flushHeaders?.()
    response.on?.('error', () => undefined)
    this.agui.writeToResponse(response, chunk, { threadId: conversationId, runId: item.id })
    this.agui.writeToResponse(
      response,
      { type: '__run_end__' },
      { threadId: conversationId, runId: item.id },
    )
    endSse(response)
    /**
     * main 不转发 HTTP 响应体、只转发 pub/sub 帧：这条应答必须再走一次 `publishControl`，
     * 否则前端收不到 `data-queue`、原始 POST 连接会一直挂着等收尾。
     */
    if (clientId) {
      void this.streamStore
        .publishControl({ clientId, runId: item.id, conversationId }, chunk)
        .catch((error: unknown) => {
          this.logger.warn('ai.run_queue.ack_publish_failed', {
            conversationId,
            queueId: item.id,
            reason: error instanceof Error ? error.message : String(error),
          })
        })
    }
    this.logger.log('ai.chat.queued', {
      conversationId,
      queueId: item.id,
      source: 'user',
    })
  }

  /** 新 run 启动 → 推 `conversation.run.started`（排队 / 唤醒没有前端连接，靠它自动续流） */
  private async notifyRunStarted(
    conversationId: string,
    runId: string,
    origin: 'user' | 'subagent',
  ): Promise<void> {
    if (!this.runEvents) return
    try {
      await this.runEvents.started(conversationId, runId, origin)
    } catch (error) {
      this.logger.warn('ai.run_status.started_failed', {
        conversationId,
        runId,
        reason: error instanceof Error ? error.message : String(error),
      })
    }
  }

  /**
   * 父 run 结束（stop / 失败）→ 级联取消：
   * - 它派出的子 run（子会话里还在跑的）；
   * - 该会话所有 `subagent` 队列项（待唤醒的不再唤醒；用户消息不动）。
   *
   * 幂等：重复调用只是再查一遍。
   */
  private async cascadeStop(runId: string, conversationId: string): Promise<void> {
    // 网关侧本轮的 session 任务一并取消（helper 内部吞错：网关抖不能拦住本地停止）
    await cancelRemoteRunTasks(runId, this.logger)
    try {
      const children = await this.runs.listChildren(runId)
      for (const child of children) {
        await this.runs.cancelActive(child.conversationId)
        await this.runQueue?.cancelByDedupe(child.id)
      }
      await this.runQueue?.cancelConversation(conversationId, 'subagent')
    } catch (error) {
      this.logger.warn('ai.run.cascade_cancel_failed', {
        runId,
        conversationId,
        reason: error instanceof Error ? error.message : String(error),
      })
    }
  }

  private requireMastra(): Mastra {
    if (!this.mastra) throw new AgentUnavailableError()
    return this.mastra
  }
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
 * - 重连：快照 + `sinceRev` 增量（不再整轮重放），没有进行中的流则回 204。
 */
export const STREAM_HEARTBEAT_MS = 15_000
export const STREAM_PROGRESS_THROTTLE_MS = 1_000

/** 流式片段的最小结构（录制器与转发共用） */

/** Express Response 的最小接口（只在编排层用，避免把 express 类型铺进来） */
/**
 * 挂起块里的 `runId` 是 Mastra 的 engineRunId（`eng_...`）；前端回答时要调
 * `POST /agent/chat/resume`，参数必须是**应用 run id**。这里换掉并保留 engineRunId。
 */
const normalizeSuspendedChunk = <T extends UiChunkLike>(chunk: T, runId: string): T => {
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

/**
 * 工具把失败当结果返回（顶层 `ok: false`）时，**客户端也按失败呈现**。
 *
 * 录制器那边同样会把它标成 `output-error`（口径一致）；模型看到的数据不变 ——
 * 它已经拿到了这份结果，只是前端与统计不该把它算成"成功"。
 */
const toClientToolChunk = <T extends UiChunkLike>(chunk: T): T => {
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
