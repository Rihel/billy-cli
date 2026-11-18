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
  type AgentRunSnapshotModel,
  type ChatAttachmentModel,
} from '@repo/shared'
import type { Mastra } from '@mastra/core/mastra'
import { RequestContext } from '@mastra/core/request-context'
import { AGENT_MAX_STEPS, AGENT_TOOL_CONCURRENCY } from '../core/constants.js'
import { AgentConfig, type AgentConfig as AgentConfigValue } from '../core/config.js'
import {
  AgentFailedError,
  AgentUnavailableError,
  ConversationBusyError,
  ModelNoResponseError,
  ProviderAuthFailedError,
  ProviderRateLimitedError,
  RunNotFoundError,
  RunNotSuspendedError,
} from '../core/errors.js'
import { AGENT_REGISTRY } from '../agents/registry.js'
import { MASTRA } from '../mastra/ai.mastra.js'
import {
  AGENT_MEMORY,
  agentMemory as sharedAgentMemory,
  memoryHistoryOptions,
} from '../mastra/agent-memory.js'
import { type AgentRuntimeEnvelope, type RuntimeModel } from '../core/envelope.js'
import { RUNTIME_MODEL_RESOLVER, type RuntimeModelResolver } from './model-resolver.js'
import { cancelRemoteRunTasks } from './remote-tool.client.js'
import type { AgentDefinition, AgentRegistry } from '../agents/types.js'
import { buildEnvironmentData } from '../core/prompts/environment.js'
import { PROMPT_ENGINE, type PromptEngine } from '../core/prompts/prompt.engine.js'
import { SkillLoader } from '../core/skills/index.js'
import { ToolRegistry } from '../core/tools/tool.registry.js'
import { ToolCallMetaStore } from '../core/tools/tool.meta.js'
import { toMastraModelInstance } from '../mastra/agent.adapter.js'
import { toRequestContext } from '../mastra/context.adapter.js'
import type { ConversationEntity, ConversationRunQueueEntity, TimelineEntity } from '@repo/db'
import { AgentConversationService } from './conversation.service.js'
import { AgentTitleService, type FirstTurnTitle } from './title.service.js'
import { ContextService } from './context.service.js'
import { ChatAttachmentService, withUserContent } from './chat-attachment.service.js'
import { ConversationRepository } from './conversation.repository.js'
import { RunRepository } from './run.repository.js'
import { ConversationRunQueue } from './run-queue.service.js'
import { RunStatusStream } from './run-status.stream.js'
import { TimelineRepository } from './timeline.repository.js'
import { FileService, type FileContext } from '../files/file.service.js'
import { AttachmentKeyPolicy } from './attachment-key.js'
import { MemoryService } from '../memory/memory.service.js'
import { MemoryExtractorService } from '../memory/memory.extractor.service.js'
import { runContextCompression } from '../mastra/summarizer.js'
import { toRehydrateMessages } from '../memory/memory.rehydrate.js'
import { AgentStreamStore } from './stream-store.service.js'
import { StreamRecorder, toolFailureOf } from './stream-recorder.js'
import { fitMessagesToToolBudget } from './turn-budget.js'
import { readStreamSteps, readStreamUsage } from './stream-result.js'
import { createLiveUsage } from './live-usage.js'
import { coalesceDeltas, resumeSafeChunks } from './stream-resume.js'
import { buildRunSnapshot, decodeRecords, openPartChunks } from './run-snapshot.js'
import { buildMessageParts } from './message-snapshot.js'
import { toPlanPayload } from './plan.protocol.js'
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
const SUMMARY_INSTRUCTION = dedent`
  请把上面的对话压缩成一份简明摘要，供后续对话继续使用。
  要求：
  1. 保留事实（用户是谁、问过什么、结论是什么、涉及的具体数据）；
  2. 保留未完成的事项与用户明确的偏好；
  3. 不要评价、不要扩写、不要编造；
  4. 用简体中文，控制在 500 字以内。
`

/** 摘要正文之外，摘要事件还要记住它覆盖了哪一段 */
const SUMMARY_MAX_CHARS = 2_000
/** 摘要调用的输出上限（500 字的摘要给 800 token 足够，防止模型长篇发挥） */
const SUMMARY_MAX_OUTPUT_TOKENS = 800

/** 兜底会话名：首条消息里没有可用文字时用它，**不拿 URL 当名字** */
const DEFAULT_CONVERSATION_TITLE = '新对话'

/**
 * 这条消息能不能直接拿来当标题。
 *
 * 为什么不能直接用：首条消息经常只贴了一个链接（"帮我看看这个"），截 40 字得到的
 * 是一串 `https://…` 或裸域名 —— 侧栏里两行都一样，谁也认不出是哪次对话。
 * 判据刻意保守：只拒绝"整体就是一个链接 / 域名 / 纯符号"的消息，正常中文开头的一句
 * 带链接的话仍然照常截断（那句话本身有信息量）。
 */
const looksLikeUrlOnly = (text: string): boolean => {
  const compact = text.trim()
  if (!compact) return true
  if (/^https?:\/\/\S+$/i.test(compact)) return true
  if (/^www\.\S+$/i.test(compact)) return true
  // 裸域名（例如 example.com/path）：要求整串只有域名与路径，不含空格
  if (/^[\w-]+(\.[\w-]+)+(\/\S*)?(\?\S*)?$/i.test(compact)) return true
  // 纯标点 / 纯符号
  return !/[\p{L}\p{N}]/u.test(compact)
}

/** 用首条用户消息生成会话标题（不额外调模型，省钱）；没有可用文字时给默认名 */
const titleFrom = (message: string): string => {
  const text = message.replace(/\s+/g, ' ').trim()
  if (looksLikeUrlOnly(text)) return DEFAULT_CONVERSATION_TITLE
  return text.slice(0, 40)
}

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
    : { text: input.message }

/** 队列 payload 的最小结构（jsonb 里存的是 unknown，读回来必须自己收口） */
interface QueuedUserPayload {
  message: string
  modelId?: string
  attachments?: ChatAttachmentModel[]
  isAdmin: boolean
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
  return {
    message,
    isAdmin: payload.isAdmin === true,
    ...(asText(payload.modelId) ? { modelId: asText(payload.modelId) as string } : {}),
    ...(attachments && attachments.length > 0 ? { attachments } : {}),
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
  ) {}

  /** 主 agent 的对话记忆（与 createMastra 共用同一个实例） */
  private get agentMemory(): typeof sharedAgentMemory {
    return this.injectedMemory ?? sharedAgentMemory
  }

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

  /**
   * **首轮命名的前提**：这一轮是首轮，且标题还是「兜底那版」。
   *
   * 首轮之后（`turnCount > 0`）不再自动改名；用户中途改过名（标题已不是
   * `titleFrom(首条消息)`）也永远听用户的 —— 后台不许悄悄冲掉人工名字。
   */
  private needsFirstTurnTitle(conversation: ConversationEntity, message: string): boolean {
    if (conversation.turnCount > 0) return false
    return !conversation.title || conversation.title === titleFrom(message)
  }

  /**
   * **首轮命名**：run 一启动就和主回答**并行**跑（早就不在收尾里做了）。
   *
   * - 先落兜底名（首条消息截出来的那版），侧栏立刻有名字，不用等模型；
   * - 名字一回来就落库 + 推整站 SSE（`conversation.title.changed`），前端当场更新；
   * - 失败（超时 / 报错 / 被取消）只 warn 并保住兜底名 —— 返回的 promise **不会 reject**，
   *   调用方在收尾处 `await` 它，只为把这次调用的 token 并进这一轮的账。
   *
   * `signal` 是这一轮的中止信号：用户点停止 → 命名调用一起断开。
   */
  private startFirstTurnTitle(
    conversation: ConversationEntity,
    runId: string,
    message: string,
    model: RuntimeModel,
    signal?: AbortSignal,
  ): Promise<FirstTurnTitle | null> {
    if (!this.needsFirstTurnTitle(conversation, message)) return Promise.resolve(null)
    // 立即起跑（async IIFE 同步执行到第一个 await）：兜底名先落，再等模型
    return (async () => {
      await this.writeFallbackTitle(conversation, message)
      const generated = await this.titles.generateFirstTurnTitle({
        conversationId: conversation.id,
        runId,
        message,
        model,
        ...(signal ? { signal } : {}),
      })
      if (generated?.title) await this.commitTitle(conversation, message, generated.title)
      return generated
    })().catch((error: unknown) => {
      // 起名是"锦上添花"：任何意外都不能影响这一轮，更不能让调用方的 await 炸掉收尾
      this.logger.warn('ai.conversation.title_failed', {
        conversationId: conversation.id,
        runId,
        reason: error instanceof Error ? error.message : String(error),
      })
      return null
    })
  }

  /**
   * 落**兜底名**：只在标题还空着时写（用户改过的名、模型起的名都不动）。
   * 失败只 warn —— 起名是锦上添花，不能影响这一轮。
   */
  private async writeFallbackTitle(
    conversation: ConversationEntity,
    message: string,
  ): Promise<void> {
    if (conversation.title) return
    try {
      const title = titleFrom(message)
      await this.conversationRepo.setTitle(conversation.id, title)
      conversation.title = title
    } catch (error) {
      this.logger.warn('ai.conversation.title_fallback_failed', {
        conversationId: conversation.id,
        reason: error instanceof Error ? error.message : String(error),
      })
    }
  }

  /**
   * 落**模型起的名字**：写库前重读一次标题 —— 命名与主回答并行，这段等待期间用户可能
   * 已经手动改名（那就永远听用户的）。落库后推整站 SSE，侧栏 / 页头不用等下一次刷新。
   */
  private async commitTitle(
    conversation: ConversationEntity,
    message: string,
    title: string,
  ): Promise<void> {
    const fallback = titleFrom(message)
    const fresh = await this.conversationRepo.findEntity(conversation.id)
    if (!fresh) return
    if (fresh.title && fresh.title !== fallback) return
    await this.conversationRepo.setTitle(conversation.id, title)
    conversation.title = title
    await this.runEvents?.titleChanged(conversation.id, title)
  }

  /** 本进程内活动运行的中止控制器（跨副本经 Redis 停止频道广播） */
  private readonly activeRuns = new Map<string, AbortController>()

  async chat(userId: string, input: AgentChatDto, isAdmin = false): Promise<AgentChatResultModel> {
    const mastra = this.requireMastra()
    const conversation = await this.resolveConversation(userId, input)
    const definition = this.registry.resolve(input.agentKey ?? conversation.agentKey)

    const run = await this.startRun(conversation, definition.key, userId)
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
      // ① 解析本轮模型（**只能来自库里的配置**；解析不出来直接 3406/3402，不建流不烧钱）
      const model = await this.resolveRuntimeModel(definition, input.modelId, {
        runId: run.id,
        conversationId: conversation.id,
        identityType: isAdmin ? 'admin' : 'user',
        identityId: userId,
      })
      const modelInstance = await this.resolveModelInstance(model)
      // 首轮命名：**与主回答并行**起跑（早就不再放收尾），失败只留兜底名。
      // 非流式入口没有可取消的运行，因此不传中止信号。
      const titlePromise = this.startFirstTurnTitle(conversation, run.id, input.message, model)

      // ② 组装上下文（窗口优先用库里配的实测值；超限则先压缩一次再重新组装，只压一次）
      let built = await this.buildContext(
        conversation.id,
        conversation.userId,
        definition,
        input.message,
        model,
        input.attachments,
      )
      if (built.needsCompaction && built.compactionRange) {
        await this.summarize(conversation.id, run.id, built.compactionRange, model)
        built = await this.buildContext(
          conversation.id,
          conversation.userId,
          definition,
          input.message,
          model,
          input.attachments,
        )
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
      })

      // ② 用户消息先落库（之后无论成败，审计上都能看到"用户问了什么"）
      const now = new Date()
      await this.timelines.append({
        conversationId: conversation.id,
        runId: run.id,
        role: TimelineRole.User,
        kind: TimelineKind.Text,
        payload: userMessagePayload(input),
        startedAt: now,
        finishedAt: now,
      })

      // ④ 调模型（工具往返都在这一步内部完成；运行时信封带"这一轮用哪个模型"+ 开局环境）
      const requestContext = await this.buildRuntimeContext(
        conversation.id,
        run.id,
        definition,
        userId,
        model,
        {
          fileAccess: conversation.fileAccess,
          workspaceConversationId: conversation.rootConversationId ?? conversation.id,
          systemPrompt: await this.resolveSystemPrompt(conversation, run.id, definition),
          // 身份要进运行时信封：admin 作用域的工具（skill-*）按它过滤工具面。
          // 漏传的后果是模型手上根本没有这些工具，只能绕去 bash 写盘（2026-11-11 实际踩过）。
          isAdmin,
        },
      )
      const agent = mastra.getAgent(definition.key)
      const result = await agent.generate(built.messages as never, {
        maxSteps: AGENT_MAX_STEPS,
        // 工具调用并发策略：只有真的调用了挂起类工具的那一步串行，其余按并发跑
        // （子 agent 的并行由此打开；同时跑几个由 AgentRunner 的闸门管，见 constants.ts）
        toolCallConcurrency: AGENT_TOOL_CONCURRENCY,
        requestContext,
        // 与流式同一口径：历史来自同一个 thread，预算按这一轮的窗口算
        memory: {
          ...(await this.ensureAgentThread(conversation.id, userId)),
          options: memoryHistoryOptions(built.snapshot.windowTokens),
        },
        // 显式传模型实例：不依赖 Agent 上的动态 model（Mastra 自解析配置那一层曾丢过多模态，见 resolveModelInstance）
        model: modelInstance as never,
        // 与流式同一口径：引擎 runId 由我们定、并回写到 `runs.engine_run_id`（durable 快照靠它认亲）
        runId: run.engineRunId,
        // 轮内预算：每一步前把工具结果的累计体积压回窗口预算内
        prepareStep: this.buildPrepareStep(built.snapshot.windowTokens),
      })

      // ④ 逐事件落时间线（保真：文本 / 推理 / 工具入参出参 / 每步用量）
      const steps = (result.steps ?? []) as unknown as StepLike[]
      const persisted = await this.persistSteps(conversation.id, run.id, steps)

      // ⑤ 记忆抽取仍在收尾（它要读完整一轮）；命名已与主回答并行跑完，这里只等它并账
      const extracted = this.memoryExtractor
        ? await this.memoryExtractor.maybeExtract({
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

      // ⑤ 收尾：终态 + 消耗（含子 agent 汇总与这次命名）+ 统计 + 会话累计 + 标题
      const usageBase = await this.rollUpUsage(
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
      await this.runs.finish(run.id, {
        status: RunStatus.Succeeded,
        usage,
        stepCount: steps.length,
        toolCallCount: persisted.toolCallCount,
        durationMs,
      })
      await this.conversationRepo.accumulate(conversation.id, totalTokensOf(usage))

      this.logger.log('ai.chat.succeeded', {
        conversationId: conversation.id,
        runId: run.id,
        agentKey: definition.key,
        stepCount: steps.length,
        toolCallCount: persisted.toolCallCount,
        durationMs,
      })

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
      // 父 run 失败 → 级联取消子 agent 与待唤醒项（与流式路径同一口径）
      await this.cascadeStop(run.id, conversation.id)
      // 失败的一轮也要有会话名（否则首轮失败就留一条空白会话）
      await this.writeFallbackTitle(conversation, input.message)
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
      userId,
      isAdmin,
      runId,
      toolCallId: null,
    }
    await this.files.registerInbound(ctx, attachments)
    await this.files.materializeInbound(ctx, attachments)
  }

  private async startRun(
    conversation: ConversationEntity,
    agentKey: string,
    userId: string,
    origin: 'user' | 'subagent' = 'user',
  ) {
    try {
      const run = await this.runs.create({
        conversationId: conversation.id,
        agentKey,
        status: RunStatus.Pending,
        triggeredBy: userId,
        origin,
      })
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
      await this.runs.markRunning(run.id, engineRunId)
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
  private async resolveModelInstance(model: RuntimeModel): Promise<unknown> {
    return (await toMastraModelInstance(model)).instance
  }

  /** 把一段旧对话压缩成摘要事件（原文保留，摘要只作"给模型看的新起点"） */
  private async summarize(
    conversationId: string,
    runId: string,
    range: { fromSeq: number; toSeq: number },
    model: RuntimeModel,
  ): Promise<void> {
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

    const coversSeqs = [[range.fromSeq, range.toSeq]]
    const startedAt = new Date()
    // 开始压缩：先落一条状态事件。压缩发生在建流之前（客户端还没连上），所以看不到实时帧，
    // 但审计 / 复盘能看出"这一段在做什么"，失败时也能与 compact_failed 对上。
    await this.timelines.append({
      conversationId,
      runId,
      role: TimelineRole.System,
      kind: TimelineKind.Status,
      payload: { status: 'compacting', coversSeqs, sourceEventCount: events.length },
      startedAt,
    })

    try {
      // 隔离调用：不带工具 / 技能 / 记忆，避免模型在这一步调工具导致摘要为空
      const result = await runContextCompression({
        model,
        instructions: SUMMARY_INSTRUCTION,
        transcript: lines.join('\n'),
        maxOutputTokens: SUMMARY_MAX_OUTPUT_TOKENS,
      })
      const text = ((result.text as string) ?? '').slice(0, SUMMARY_MAX_CHARS)
      if (!text) {
        // 模型返回空：不静默吞掉，留一条状态让复盘能看出"这里本该有摘要"
        await this.timelines.append({
          conversationId,
          runId,
          role: TimelineRole.System,
          kind: TimelineKind.Status,
          payload: { status: 'compact_empty', coversSeqs },
          finishedAt: new Date(),
        })
        return
      }
      const summary = await this.timelines.append({
        conversationId,
        runId,
        role: TimelineRole.System,
        kind: TimelineKind.Summary,
        payload: {
          text,
          coversSeqs,
          model: model.modelRef,
          sourceEventCount: events.length,
        },
        usage: toUsageRecord(result.usage as never),
        startedAt,
        finishedAt: new Date(),
        durationMs: Date.now() - startedAt.getTime(),
      })
      await this.timelines.append({
        conversationId,
        runId,
        role: TimelineRole.System,
        kind: TimelineKind.Status,
        payload: { status: 'compacted', coversSeqs, summarySeq: summary.seq },
        finishedAt: new Date(),
      })
      this.logger.log('ai.context.compacted', {
        conversationId,
        runId,
        coversSeqs: [range.fromSeq, range.toSeq],
        sourceEventCount: events.length,
        summarySeq: summary.seq,
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
          // `id` 与流式路径同一口径（`stream-recorder` 的 `payload.id`）：恢复时快照与增量
          // 按 part id 去重，缺了它同一段会被补两遍。非流式没有流式 part id，用派生 id 即可
          // —— 唯一性范围是一条消息，`messageId` 已经按 run + 步号唯一。
          payload: { text: reasoning, id: `${messageId}:reasoning` },
        })
      }
      if (step.text) {
        items.push({
          role: TimelineRole.Assistant,
          kind: TimelineKind.Text,
          messageId,
          payload: { text: step.text, id: `${messageId}:text` },
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
    let run: { id: string; engineRunId: string }
    try {
      run = await this.startRun(conversation, definition.key, userId)
    } catch (error) {
      if (error instanceof ConversationBusyError && this.runQueue) {
        const queued = await this.enqueueUserMessage(conversation, input, isAdmin)
        this.writeQueuedAck(response, conversation.id, queued, userId, clientId)
        return
      }
      throw error
    }
    await this.registerInboundFiles(conversation, run.id, userId, isAdmin, input.attachments)
    await this.notifyRunStarted(conversation.id, run.id, 'user')
    const startedAt = Date.now()

    // 本进程内中止控制器：**在建流之前就登记**，否则"解析模型时用户点停止"找不到目标
    const abort = new AbortController()
    this.activeRuns.set(run.id, abort)
    if (clientId) await this.streamStore.bindClient(run.id, clientId)

    let heartbeat: NodeJS.Timeout | undefined
    let unsubscribeStop: (() => void) | null = null
    /** 响应头是否已经发出（决定失败时是「抛回 HTTP」还是「按 SSE 收尾」） */
    let streamStarted = false
    /**
     * 首 token 看护：从发起模型调用到**第一段输出**之间没有任何动静就中止。
     *
     * 单独一个标记而不是直接看 `abort.signal.aborted`：那个信号也用于"用户点停止"，
     * 两者语义不同（一个是 3314 失败，一个是 canceled），必须在收尾时分得清。
     */
    let firstTokenTimer: NodeJS.Timeout | undefined
    let firstTokenTimedOut = false
    let firstTokenSeen = false

    const stopFirstTokenTimer = (): void => {
      if (!firstTokenTimer) return
      clearTimeout(firstTokenTimer)
      firstTokenTimer = undefined
    }
    /** 收到第一段输出（文本 / 推理 / 工具入参）就撤掉看护 */
    const markFirstTokenSeen = (): void => {
      if (firstTokenSeen) return
      firstTokenSeen = true
      stopFirstTokenTimer()
    }
    const armFirstTokenTimer = (): void => {
      const timeoutMs = this.config.firstTokenTimeoutMs
      if (!timeoutMs || firstTokenTimer) return
      firstTokenTimer = setTimeout(() => {
        firstTokenTimedOut = true
        // 走同一个 abort：Mastra 收流后会正常返回，收尾分支按"超时失败"处理
        abort.abort()
      }, timeoutMs)
      firstTokenTimer.unref?.()
    }

    const stopHeartbeat = (): void => {
      if (!heartbeat) return
      clearInterval(heartbeat)
      heartbeat = undefined
    }

    /**
     * 起心跳：SSE 注释帧（保连接）+ **DB 租约**（保这一轮不被看门狗误杀）。
     *
     * 间隔必须显著小于网关空闲超时（默认 15s < keepAliveTimeout 75s），否则"AI 想得久一点就断流"。
     * 模型在**吐出第一个 token 之前**可能安静很久（长上下文 + 推理型模型），
     * 所以从建流前就开始续租 —— 看门狗判的是「还有没有人在管这一轮」，不是「有没有产出」。
     */
    const ensureHeartbeat = (): void => {
      if (heartbeat) return
      heartbeat = setInterval(() => {
        // ① 先续租：即使客户端已经断开，这一轮仍然有人在管（生成还在继续，可重连续看）
        void this.runs.touchHeartbeat(run.id).catch(() => undefined)
        // ② 再 best-effort 写注释帧：写失败只说明连接没了，不能把进程带走。
        //    必须等 `writeHead` 之后才写 —— 在响应头之前写会隐式发出 200 + 默认响应头，
        //    随后 `writeHead(200, SSE_HEADERS)` 会抛 ERR_HTTP_HEADERS_SENT（长握手 + 15s 心跳就会踩到）。
        if (streamStarted) writeSse(response, ': ping\n\n')
      }, STREAM_HEARTBEAT_MS)
      heartbeat.unref?.()
    }

    try {
      // ① 解析本轮模型（**只能来自库里的配置**；解析不出来直接 3406/3402，不建流不烧钱）
      const model = await this.resolveRuntimeModel(definition, input.modelId, {
        runId: run.id,
        conversationId: conversation.id,
        identityType: isAdmin ? 'admin' : 'user',
        identityId: userId,
      })
      const modelInstance = await this.resolveModelInstance(model)
      // 首轮命名：**与主回答并行**起跑（不阻塞这一轮；用户点停止 → 这次命名一起断开）
      const titlePromise = this.startFirstTurnTitle(
        conversation,
        run.id,
        input.message,
        model,
        abort.signal,
      )

      // ② 组装上下文（窗口优先用库里配的实测值；超限则先压缩一次再重新组装，只压一次）
      let built = await this.buildContext(
        conversation.id,
        conversation.userId,
        definition,
        input.message,
        model,
        input.attachments,
      )
      if (built.needsCompaction && built.compactionRange) {
        // 注意：压缩发生在建流之前（尚未 writeHead），它的模型调用不单独接 abortSignal ——
        // 失败会降级为纯裁剪（见 summarize），不会阻断这一轮
        await this.summarize(conversation.id, run.id, built.compactionRange, model)
        built = await this.buildContext(
          conversation.id,
          conversation.userId,
          definition,
          input.message,
          model,
          input.attachments,
        )
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
      })

      // ③ 用户消息先落库（之后无论成败，审计上都能看到"用户问了什么"）
      const now = new Date()
      await this.timelines.append({
        conversationId: conversation.id,
        runId: run.id,
        role: TimelineRole.User,
        kind: TimelineKind.Text,
        payload: userMessagePayload(input),
        startedAt: now,
        finishedAt: now,
      })

      // ④ 建流：进度 / 录制器 / 心跳 / 跨副本停止
      const streamId = `${run.id}-${Date.now()}`
      await this.runs.setActiveStream(run.id, streamId)
      if (clientId) {
        await this.streamStore.bindClient(run.id, clientId)
      }
      await this.streamStore.startRun(run.id, {
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
          isKnownTool: (toolKey) => Boolean(this.toolRegistry.get(toolKey)),
        },
      )
      let rev = 0
      const messageIdRef: { value: string } = { value: '' }
      let stepCount = 0
      let lastProgressAt = 0
      /** 这一轮流里是否出现了工具挂起（`ask-user-questions`） */
      let suspended = false

      ensureHeartbeat()

      // 跨副本停止：订阅本 run 的停止频道（请求落在别的副本时也停得掉）
      try {
        unsubscribeStop = await this.streamStore.subscribeStop(run.id, () => abort.abort())
      } catch (error) {
        this.logger.warn('ai.stream.stop_subscribe_failed', {
          runId: run.id,
          reason: error instanceof Error ? error.message : String(error),
        })
      }

      const requestContext = await this.buildRuntimeContext(
        conversation.id,
        run.id,
        definition,
        userId,
        model,
        // 中止信号（用户停止要停整棵树）+ 渲染后的系统指令（首轮末尾带运行环境）
        {
          fileAccess: conversation.fileAccess,
          workspaceConversationId: conversation.rootConversationId ?? conversation.id,
          abortSignal: abort.signal,
          systemPrompt: await this.resolveSystemPrompt(conversation, run.id, definition),
          // 同上：工具面按身份过滤，admin 的 skill-* 工具要靠这个字段才出现
          isAdmin,
        },
      )
      const agent = mastra.getAgent(definition.key)
      const memoryThread = await this.ensureAgentThread(conversation.id, userId)
      // 模型可能"卡住不吐字"：从发起调用开始计时，第一段输出到了就撤（见上方 firstTokenTimer）
      armFirstTokenTimer()
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
        model: modelInstance as never,
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
            // 第一段输出到了：撤掉首 token 看护（文本 / 推理 / 工具入参都算"模型动了"）
            if (
              chunk.type === 'text-delta' ||
              chunk.type === 'reasoning-delta' ||
              chunk.type === 'tool-input-available'
            ) {
              markFirstTokenSeen()
            }
            // 挂起是这一轮的"暂停"，不是成功；收尾分支据此决定 finish 还是 suspend。
            if (chunk.type === 'data-tool-call-suspended') suspended = true
            const recordedChunk = normalizeSuspendedChunk(chunk, run.id)
            // 客户端看到的那一份：`ok:false` 的结果按失败呈现（录制器仍拿原始片段，出参全量入库）
            const outgoing = toClientToolChunk(recordedChunk)
            // 先给客户端，再落库：用户的体感不该被落库拖慢
            controller.enqueue(outgoing)
            try {
              // 闸门要在**落时间线之前**等：先落库再等，补发可能把这条已闭合 part 读进快照，
              // 闸门放开后实时又发一遍 → 重复
              await this.streamStore.waitForReplayGate(run.id)
              await recorder.consume(recordedChunk)
              rev = await this.emitAgUi({
                runId: run.id,
                threadId: conversation.id,
                chunk: outgoing,
                messageIdRef,
              })
              if (chunk.type === 'start-step') stepCount += 1
              const nowMs = Date.now()
              if (nowMs - lastProgressAt >= STREAM_PROGRESS_THROTTLE_MS) {
                lastProgressAt = nowMs
                await this.streamStore.patchRun(run.id, {
                  stage:
                    chunk.type === 'tool-input-available'
                      ? `tool:${chunk.toolName ?? ''}`
                      : 'generating',
                  rev,
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
      rev = await this.emitAgUi({
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
        this.writeAgUiChunk(response, value, {
          threadId: conversation.id,
          runId: run.id,
          ...(messageIdRef.value ? { messageId: messageIdRef.value } : {}),
        })
        // 挂起事件到了就主动收流：Mastra 的挂起流不会再自己结束（它在等 resume），
        // 继续 read 会一直挂着，会话永远不释放。cancel 上游，下面按 suspended 收尾。
        if (value.type === 'data-tool-call-suspended') {
          // 不 cancel 上游：挂起后 Mastra 还要把嵌套 workflow 的快照补完整；
          // 直接断读会让 resume 拿到缺了嵌套 step input 的快照。
          break
        }
      }

      // 被中止时 Mastra 会**正常返回**（流被截断但不抛错）→ 必须自己判定"这不是成功，是取消"
      if (abort.signal.aborted) {
        await recorder.flushPending()
        // 首 token 超时也走 abort，但语义是"失败"不是"用户取消"（收尾分支据此分流）
        throw new Error(firstTokenTimedOut ? 'first_token_timeout' : 'stream_aborted_by_user')
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
      if (suspended) {
        const suspendSteps = (await readStreamSteps(output)) as unknown as StepLike[]
        const persistedSuspend = await recorder.finish(suspendSteps)
        const suspendUsage = await this.rollUpUsage(
          run.id,
          toUsageRecord(await readStreamUsage(output)),
        )
        await this.runs.suspend(run.id, {
          usage: suspendUsage,
          stepCount: suspendSteps.length,
          toolCallCount: persistedSuspend.toolCallCount,
          durationMs: Date.now() - startedAt,
        })
        await this.runs.setActiveStream(run.id, null)
        stopHeartbeat()
        await this.emitAgUi({
          runId: run.id,
          threadId: conversation.id,
          chunk: {
            type: 'data-run-suspended',
            data: { runId: run.id, conversationId: conversation.id },
          },
          response,
          messageIdRef,
        })
        await this.finishAgUiRun(response, run.id, conversation.id)
        this.logger.log('ai.stream.suspended', {
          conversationId: conversation.id,
          runId: run.id,
          stepCount: suspendSteps.length,
          toolCallCount: persistedSuspend.toolCallCount,
        })
        return
      }

      // 收尾：**先 Postgres 终态，再清 Redis 进度**（反过来会留下"没进度也没结果"的窗口）
      // 步骤 / 用量一律走 stream-result 的读取口径：`agent.stream()` 在**可恢复执行（durable）**下
      // 返回的是包装对象（`{ output, fullStream, … }`），真正的 `MastraModelOutput` 在 `output` 里 ——
      // 直接读 `output.steps` 会拿到 undefined（踩过的崩点，见 stream-result.ts 的注释）
      const steps = (await readStreamSteps(output)) as unknown as StepLike[]
      const persisted = await recorder.finish(steps)
      // 记忆抽取仍在收尾（要读完整一轮）；命名已与主回答并行跑完，这里只等它并账
      const extracted = this.memoryExtractor
        ? await this.memoryExtractor.maybeExtract({
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
      const usageBase = await this.rollUpUsage(run.id, toUsageRecord(await readStreamUsage(output)))
      // 并账要**保留 usageBase 里的非 token 字段**（如 `subAgents`）：
      // `mergeUsage` 只逐字段加 token，直接把它的结果当 usage 会把那些字段抹掉（踩过：子 agent 明细消失）
      // 并账：命名 + 记忆抽取的用量都要进这一轮的账（mergeUsage 只加 token，非 token 字段要保留）
      let usage = usageBase
      for (const extra of [title?.usage, extracted?.usage]) {
        if (extra) usage = { ...usage, ...mergeUsage(usage, extra) }
      }
      const durationMs = Date.now() - startedAt
      await this.runs.finish(run.id, {
        status: RunStatus.Succeeded,
        usage,
        stepCount: steps.length,
        toolCallCount: persisted.toolCallCount,
        durationMs,
        // 首 token 耗时（毫秒）：只有流式路径量得到；没有输出过就是 null，不编 0
        firstTokenMs:
          recorder.firstOutputAtMs === null ? null : recorder.firstOutputAtMs - startedAt,
      })
      await this.runs.setActiveStream(run.id, null)
      await this.conversationRepo.accumulate(conversation.id, totalTokensOf(usage))

      this.logger.log('ai.stream.succeeded', {
        conversationId: conversation.id,
        runId: run.id,
        stepCount: steps.length,
        toolCallCount: persisted.toolCallCount,
        durationMs,
      })

      /**
       * **本轮用量**下发（`data-run-usage`，**不带 id**：一块一个）。
       *
       * 为什么走流而不是让前端再查一次：用量只有收尾时才知道，而"收尾已落库"与"RUN_FINISHED"之间
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
      }
      await this.emitAgUi({
        runId: run.id,
        threadId: conversation.id,
        chunk: usageChunk,
        response,
        messageIdRef,
      })

      // 终态已落库 → 先停心跳，再告诉客户端"这一轮结束"：
      // 顺序反了会留出"response 已 end、定时器又写一帧"的窗口（正是进程被杀的那个 bug）
      stopHeartbeat()
      await this.finishAgUiRun(response, run.id, conversation.id)
    } catch (error) {
      const durationMs = Date.now() - startedAt
      const reason = error instanceof Error ? error.message : String(error)
      let mapped: Error | null = null

      // 首 token 超时也调用了 abort，但它是**失败**（3314），不是用户取消（canceled）
      if (firstTokenTimedOut) {
        mapped = new ModelNoResponseError(this.config.firstTokenTimeoutMs)
        await this.runs.finish(run.id, {
          status: RunStatus.Failed,
          usage: await this.rollUpUsage(run.id, null),
          errorCode: String(AppErrorCodes.ModelNoResponse),
          errorStage: RunErrorStage.Model,
          errorMessage: mapped.message,
          errorDetail: { raw: reason, timeoutMs: this.config.firstTokenTimeoutMs },
          durationMs,
        })
        await this.timelines.append({
          conversationId: conversation.id,
          runId: run.id,
          role: TimelineRole.System,
          kind: TimelineKind.Error,
          payload: {
            message: mapped.message,
            stage: RunErrorStage.Model,
            reason: 'first_token_timeout',
          },
          finishedAt: new Date(),
        })
        this.logger.error('ai.stream.first_token_timeout', {
          runId: run.id,
          timeoutMs: this.config.firstTokenTimeoutMs,
          durationMs,
        })
        // 父 run 失败 → 级联取消它派出去、还在跑的子 agent，以及待唤醒的队列项
        await this.cascadeStop(run.id, conversation.id)
        // 失败的一轮也要有会话名（否则侧栏是一条空白）
        await this.writeFallbackTitle(conversation, input.message)
      } else if (abort.signal.aborted) {
        // 用户主动停止：是 canceled，不是 failed（语义要分清）
        await this.runs.finish(run.id, {
          status: RunStatus.Canceled,
          durationMs,
        })
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
        })
        // 用户 stop：子 agent 与待唤醒项一起取消（设计 §7）
        await this.cascadeStop(run.id, conversation.id)
        this.logger.log('ai.stream.canceled', { runId: run.id, durationMs })
      } else {
        mapped = classifyModelError(error)
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
        await this.cascadeStop(run.id, conversation.id)
        this.logger.error('ai.stream.failed', {
          runId: run.id,
          reason,
          durationMs,
        })
        // 失败的一轮也要有会话名（以前只有成功收尾才落标题 → 失败会话在侧栏是一条空白）
        await this.writeFallbackTitle(conversation, input.message)
      }

      await this.runs.setActiveStream(run.id, null)

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
      await this.finishAgUiRun(response, run.id, conversation.id)
    } finally {
      stopHeartbeat()
      stopFirstTokenTimer()
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
          await this.emitAgUi({
            runId: run.id,
            threadId: conversation.id,
            chunk: { type: STREAM_END_MARKER },
          })
        }
      } catch {
        // 广播失败无碍：补发连接会被客户端的 idle 处理或下一次刷新收敛
      }
      try {
        await this.streamStore.clearRun(run.id)
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
  ): Promise<void> {
    const mastra = this.requireMastra()
    const run = await this.runs.findEntity(input.runId)
    if (!run) throw new RunNotFoundError(input.runId)
    const conversation = await this.conversations.requireOwned(userId, run.conversationId)
    if (run.status !== RunStatus.Suspended || !run.engineRunId) {
      throw new RunNotSuspendedError(run.id)
    }
    if (clientId) await this.streamStore.bindClient(run.id, clientId)

    /** 取消整组回答：不带答案，只把"用户取消"这个结论交回工具 */
    const cancelled = input.cancelled === true
    const answers = input.answers ?? []
    const definition = this.registry.resolve(conversation.agentKey)
    const startedAt = Date.now()
    const abort = new AbortController()
    this.activeRuns.set(run.id, abort)

    let heartbeat: NodeJS.Timeout | undefined
    let streamStarted = false
    const stopHeartbeat = (): void => {
      if (!heartbeat) return
      clearInterval(heartbeat)
      heartbeat = undefined
    }
    const ensureHeartbeat = (): void => {
      if (heartbeat) return
      heartbeat = setInterval(() => {
        void this.runs.touchHeartbeat(run.id).catch(() => undefined)
        if (streamStarted) writeSse(response, ': ping\n\n')
      }, STREAM_HEARTBEAT_MS)
      heartbeat.unref?.()
    }

    /** 首 token 看护：续跑同样要防"模型卡住不吐字"（与 chatStream 同一口径） */
    let firstTokenTimer: NodeJS.Timeout | undefined
    let firstTokenTimedOut = false
    let firstTokenSeen = false
    const stopFirstTokenTimer = (): void => {
      if (!firstTokenTimer) return
      clearTimeout(firstTokenTimer)
      firstTokenTimer = undefined
    }
    const armFirstTokenTimer = (): void => {
      const timeoutMs = this.config.firstTokenTimeoutMs
      if (!timeoutMs || firstTokenTimer) return
      firstTokenTimer = setTimeout(() => {
        firstTokenTimedOut = true
        abort.abort()
      }, timeoutMs)
      firstTokenTimer.unref?.()
    }
    const markFirstTokenSeen = (): void => {
      if (firstTokenSeen) return
      firstTokenSeen = true
      stopFirstTokenTimer()
    }

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
      await this.streamStore.startRun(run.id, {
        status: RunStatus.Running,
        stage: 'generating',
        streamId,
        rev: 0,
        step: 0,
      })

      const requestContext = await this.buildRuntimeContext(
        conversation.id,
        run.id,
        definition,
        userId,
        model,
        {
          fileAccess: conversation.fileAccess,
          workspaceConversationId: conversation.rootConversationId ?? conversation.id,
          abortSignal: abort.signal,
          systemPrompt: await this.resolveSystemPrompt(conversation, run.id, definition),
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
        model: modelInstance as never,
        abortSignal: abort.signal,
        memory: { ...memoryThread, options: memoryHistoryOptions(windowTokens) },
        savePerStep: true,
        // 轮内预算：与首轮同一口径
        prepareStep: this.buildPrepareStep(windowTokens),
      }
      armFirstTokenTimer()
      const resumeOutput = await agent.resumeStream(cancelled ? { cancelled: true } : { answers }, {
        ...runOptions,
        ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
      })

      response.writeHead(200, UI_STREAM_HEADERS)
      streamStarted = true
      ensureHeartbeat()

      const recorder = new StreamRecorder(
        this.timelines,
        { conversationId: conversation.id, runId: run.id },
        {
          metas: this.toolMetas,
          isKnownTool: (toolKey) => Boolean(this.toolRegistry.get(toolKey)),
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
            markFirstTokenSeen()
          }
          const recordedChunk = normalizeSuspendedChunk(chunk, run.id)
          const outgoing = toClientToolChunk(recordedChunk)
          await this.emitAgUi({
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
      const resumedUsage = await this.rollUpUsage(
        run.id,
        toUsageRecord(await readStreamUsage(output)),
      )
      const usage = priorUsage
        ? (mergeUsage(priorUsage, resumedUsage) ?? resumedUsage)
        : resumedUsage

      // 续跑后模型又问了下一个问题：仍然停在 suspended，不能当成成功。
      if (suspendedAgain) {
        await this.runs.suspend(run.id, {
          usage,
          stepCount: (run.stepCount ?? 0) + steps.length,
          toolCallCount: (run.toolCallCount ?? 0) + persisted.toolCallCount,
          durationMs: (run.durationMs ?? 0) + (Date.now() - startedAt),
        })
        await this.runs.setActiveStream(run.id, null)
        await this.streamStore.clearRun(run.id)
        stopHeartbeat()
        await this.finishAgUiRun(response, run.id, conversation.id)
        return
      }
      const stepCount = (run.stepCount ?? 0) + steps.length
      const toolCallCount = (run.toolCallCount ?? 0) + persisted.toolCallCount
      const durationMs = (run.durationMs ?? 0) + (Date.now() - startedAt)

      await this.runs.finish(run.id, {
        status: RunStatus.Succeeded,
        usage,
        stepCount,
        toolCallCount,
        durationMs,
      })
      await this.runs.setActiveStream(run.id, null)
      await this.streamStore.clearRun(run.id)
      await this.conversationRepo.accumulate(conversation.id, totalTokensOf(usage))

      /**
       * 续跑收尾同样下发**本轮用量**（与首轮同一条 `data-run-usage`）。
       *
       * 早先这条路只发结束帧：回答完挂起的问题后，前端右下角停在最后一条实时值
       * （`data-step-usage`）或干脆是上一轮的旧值 —— 子 agent / 命名 / 记忆抽取的并账永远到不了界面。
       * 位置同首轮：终态已落库之后、`RUN_FINISHED` 之前；也进输出记录与广播，断线补发拿得到。
       */
      const usageChunk = {
        type: 'data-run-usage',
        data: { runId: run.id, usage, stepCount, toolCallCount, durationMs },
      }
      await this.emitAgUi({
        runId: run.id,
        threadId: conversation.id,
        chunk: usageChunk,
        response,
        messageIdRef,
      })

      stopHeartbeat()
      await this.finishAgUiRun(response, run.id, conversation.id)
      this.logger.log('ai.stream.resumed', {
        conversationId: conversation.id,
        runId: run.id,
        stepCount: steps.length,
        toolCallCount: persisted.toolCallCount,
      })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      if (firstTokenTimedOut) {
        const mapped = new ModelNoResponseError(this.config.firstTokenTimeoutMs)
        await this.runs.finish(run.id, {
          status: RunStatus.Failed,
          usage: await this.rollUpUsage(run.id, null),
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
          usage: await this.rollUpUsage(run.id, null),
          errorCode: String(AppErrorCodes.AgentFailed),
          errorStage: RunErrorStage.Model,
          errorMessage: reason,
          durationMs: Date.now() - startedAt,
        })
        this.logger.error('ai.stream.resume_failed', { runId: run.id, reason })
      }
      await this.runs.setActiveStream(run.id, null)
      await this.streamStore.clearRun(run.id)
      if (!streamStarted) throw error
      await this.finishAgUiRun(response, run.id, conversation.id)
    } finally {
      stopHeartbeat()
      stopFirstTokenTimer()
      this.activeRuns.delete(run.id)
      if (streamStarted) endSse(response)
    }
  }

  /** 停止某一轮：本进程直接 abort；不在本进程则广播（跨副本） */
  async stopRun(userId: string, runId: string): Promise<AgentRunStopResultModel> {
    const run = await this.runs.findEntity(runId)
    if (!run) throw new RunNotFoundError(runId)
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
    await this.streamStore.publishStop(runId)
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
   * 正在跑的那一轮的「已闭合内容快照」。
   *
   * 前端拿到它先渲染已完成的部分，再从 `sinceRev` 接增量 —— 不必整轮重放。
   * 没有进行中的轮（或已收尾）返回 null：调用方据此不要点亮"恢复中"。
   */
  async snapshotRun(userId: string, runId: string): Promise<AgentRunSnapshotModel | null> {
    const run = await this.runs.findEntity(runId)
    if (!run) throw new RunNotFoundError(runId)
    await this.conversations.requireOwned(userId, run.conversationId)
    if (run.status !== RunStatus.Running && run.status !== RunStatus.Pending) return null
    const progress = await this.streamStore.readRun(runId)
    if (!progress || progress.status !== RunStatus.Running) return null
    /**
     * 快照要同时读时间线（parts）和输出记录（sinceRev），两个数据源之间有毫秒级窗口：
     * 期间若有一个 part 闭合，可能出现"时间线已含、记录也含"的重叠。合闸门让产事件的一侧
     * 先停一下，两次读拿到同一时刻的视图（`buildRunSnapshot` 里还有按 part id 的兜底去重）。
     */
    await this.streamStore.beginReplay(runId)
    try {
      const [snapshotData, records] = await Promise.all([
        this.loadSnapshotData(runId),
        this.streamStore.readAllEvents(runId),
      ])
      return buildRunSnapshot(run.id, records, snapshotData).snapshot
    } finally {
      await this.streamStore.endReplay(runId)
    }
  }

  /**
   * 快照的持久化来源：`timelines` 里的**全部已闭合 part** + assistant 消息 id。
   *
   * 与前端 `history.ts` 同一套映射（`buildMessageParts`）；输出记录只负责算 `sinceRev`，
   * 不再承担“快照”职责 —— 它有 20k 上限，长轮次会被裁掉头部。
   */
  private async loadSnapshotData(runId: string): Promise<{
    messageId?: string
    parts?: Array<Record<string, unknown>>
  }> {
    const items = await this.timelines.listByRun(runId)
    const messageId =
      items.find((item) => item.role === TimelineRole.Assistant && item.messageId)?.messageId ??
      null
    const parts = buildMessageParts(items)
    return {
      ...(messageId ? { messageId } : {}),
      ...(parts.length > 0 ? { parts } : {}),
    }
  }

  /** 按会话找"当前进行中的那一轮"再取快照（前端只知道会话 id 时用） */
  async snapshotCurrentRun(
    userId: string,
    conversationId?: string,
  ): Promise<AgentRunSnapshotModel | null> {
    const active = conversationId
      ? await this.runs.findActiveByConversation(userId, conversationId)
      : await this.runs.findActiveByUser(userId)
    if (!active) return null
    return this.snapshotRun(userId, active.id)
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
    if (clientId) await this.streamStore.bindClient(run.id, clientId)

    /**
     * **Postgres 终态优先于 Redis 进度**：进程崩溃时旧进程没来得及删进度键
     * （TTL 6h），启动清理把 run 标成 `interrupted` 后，Redis 里可能仍写着 `running`。
     * 只看 Redis 会让客户端"接回"一条永远不会有新事件的死流（挂到超时）。
     */
    if (run.status !== RunStatus.Running && run.status !== RunStatus.Pending) {
      return false
    }

    const progress = await this.streamStore.readRun(runId)
    if (!progress || progress.status !== RunStatus.Running) return false

    response.writeHead(200, UI_STREAM_HEADERS)
    response.flushHeaders?.()
    // 断线后的补发连接同样可能随时消失：socket 的 error 事件不能变成进程级未捕获异常
    response.on?.('error', () => undefined)

    // 先合闸门再读记录：顺序反了，读快照到合闸门之间的实时事件会插到重放前面
    await this.streamStore.beginReplay(runId)
    try {
      return await this.replayRun(run, sinceRev, response)
    } finally {
      await this.streamStore.endReplay(runId)
    }
  }

  /** 补发主体（闸门内执行；只发不订阅） */
  private async replayRun(
    run: { id: string; conversationId: string },
    sinceRev: number | undefined,
    response: StreamResponseLike,
  ): Promise<boolean> {
    const [snapshotData, records] = await Promise.all([
      this.loadSnapshotData(run.id),
      this.streamStore.readAllEvents(run.id),
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

    await this.streamStore.publishEvents(run.id, events)
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
  async startQueuedTurn(item: ConversationRunQueueEntity): Promise<{
    runId: string
    done: Promise<'succeeded' | 'failed' | 'canceled'>
  }> {
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

    if (item.source === 'subagent') {
      const wake = toSubAgentWake(payload)
      if (!wake) throw new Error('子 agent 唤醒 payload 缺少 subAgentId / subRunId / name')
      const run = await this.startRun(conversation, definition.key, conversation.userId, 'subagent')
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
    const run = await this.startRun(conversation, definition.key, conversation.userId, 'user')
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
  /**
   * **唯一发射口**：chunk → AG-UI 事件 → 输出记录（rev）→ 定向广播 →（可选）响应体。
   *
   * 四条路径（建流 / 续跑 / 无头执行 / 收尾）都必须走这里。漏一条就会留下 chunk 帧，
   * 于是"存的是事件、传的是 chunk"，两套映射迟早漂移（手册 §4.1）。
   */
  private async emitAgUi(input: {
    runId: string
    threadId: string
    chunk: unknown
    response?: StreamResponseLike
    messageIdRef?: { value: string }
  }): Promise<number> {
    // 补发闸门：补发期间产事件的一侧**不放行**，避免实时事件插到重放中间
    await this.streamStore.waitForReplayGate(input.runId)
    const chunk = input.chunk as { type?: string; messageId?: string } | null
    if (input.messageIdRef && chunk?.type === 'start' && typeof chunk.messageId === 'string') {
      input.messageIdRef.value = chunk.messageId
    }
    const events = encodeAgUiChunk(chunk as AgUiChunk, {
      threadId: input.threadId,
      runId: input.runId,
      ...(input.messageIdRef?.value ? { messageId: input.messageIdRef.value } : {}),
    })
    let rev = 0
    for (const event of events) {
      rev = await this.streamStore.appendEvent(input.runId, event)
      await this.streamStore.publishEvent(input.runId, event)
      if (input.response) writeSse(input.response, sseFrame(event))
    }
    return rev
  }

  /** 只把 chunk 编成 AG-UI 写进响应体（HTTP 体不承载消费，main 只 drain） */
  private writeAgUiChunk(
    response: StreamResponseLike,
    chunk: unknown,
    ctx: { threadId: string; runId: string; messageId?: string },
  ): void {
    for (const event of encodeAgUiChunk(chunk as AgUiChunk, ctx)) {
      writeSse(response, sseFrame(event))
    }
  }

  /** 收尾：写一帧 `RUN_FINISHED`（进记录 + 广播 + 响应体），再关响应 */
  private async finishAgUiRun(
    response: StreamResponseLike,
    runId: string,
    threadId: string,
  ): Promise<void> {
    await this.emitAgUi({ runId, threadId, chunk: { type: '__run_end__' }, response })
    endSse(response)
  }

  private async executeQueuedTurn(input: {
    run: { id: string; engineRunId: string }
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

    let heartbeat: NodeJS.Timeout | undefined
    let unsubscribeStop: (() => void) | null = null
    let firstTokenTimer: NodeJS.Timeout | undefined
    let firstTokenTimedOut = false
    let firstTokenSeen = false
    let suspended = false

    const stopHeartbeat = (): void => {
      if (!heartbeat) return
      clearInterval(heartbeat)
      heartbeat = undefined
    }
    const ensureHeartbeat = (): void => {
      if (heartbeat) return
      heartbeat = setInterval(() => {
        void this.runs.touchHeartbeat(run.id).catch(() => undefined)
        void this.streamStore
          .patchRun(run.id, { heartbeatAt: new Date().toISOString() })
          .catch(() => undefined)
      }, STREAM_HEARTBEAT_MS)
      heartbeat.unref?.()
    }
    const stopFirstTokenTimer = (): void => {
      if (!firstTokenTimer) return
      clearTimeout(firstTokenTimer)
      firstTokenTimer = undefined
    }
    const armFirstTokenTimer = (): void => {
      const timeoutMs = this.config.firstTokenTimeoutMs
      if (!timeoutMs || firstTokenTimer) return
      firstTokenTimer = setTimeout(() => {
        firstTokenTimedOut = true
        abort.abort()
      }, timeoutMs)
      firstTokenTimer.unref?.()
    }

    /** 一个片段 → AG-UI 事件 → 输出记录 + 广播（断线重连按 rev 补发） */
    const messageIdRef: { value: string } = { value: '' }
    const emit = async (chunk: unknown): Promise<number> =>
      this.emitAgUi({
        runId: run.id,
        threadId: conversation.id,
        chunk,
        messageIdRef,
      })

    let rev = 0
    try {
      // 排队过一段时间的用户消息也要登记 / 物化附件（与 `chatStream` 同一入口；失败不阻塞）
      if (origin === 'user' && input.attachments && input.attachments.length > 0) {
        await this.registerInboundFiles(conversation, run.id, userId, input.isAdmin, [
          ...input.attachments,
        ])
      }
      const model = await this.resolveRuntimeModel(definition, input.modelId, {
        runId: run.id,
        conversationId: conversation.id,
        identityType: input.isAdmin ? 'admin' : 'user',
        identityId: userId,
      })
      const modelInstance = await this.resolveModelInstance(model)
      // 首轮命名：只有用户发起的轮次才命名（子 agent 唤醒不是用户说的），与主回答并行跑
      const titlePromise =
        origin === 'user'
          ? this.startFirstTurnTitle(conversation, run.id, input.message, model, abort.signal)
          : Promise.resolve(null)

      let built = await this.buildContext(
        conversation.id,
        userId,
        definition,
        input.message,
        model,
        input.attachments,
        input.internalNotice,
      )
      if (built.needsCompaction && built.compactionRange) {
        await this.summarize(conversation.id, run.id, built.compactionRange, model)
        built = await this.buildContext(
          conversation.id,
          userId,
          definition,
          input.message,
          model,
          input.attachments,
          input.internalNotice,
        )
      }

      await this.runs.saveRequestSnapshot(run.id, {
        model: model.modelRef,
        agentKey: definition.key,
        toolKeys: this.toolRegistry.expand(definition.tools),
        skillKeys: (await this.skillLoader.resolve(definition.skills)).map((skill) => skill.name),
        params: { maxSteps: AGENT_MAX_STEPS },
        context: built.snapshot,
        // 唤醒 / 排队这一轮的来源：谁触发的、由哪条队列项调度（审计要能串起来）
        origin,
        queue: input.queue,
        ...(input.card ? { subAgent: input.card } : {}),
      })

      const now = new Date()
      if (origin === 'user') {
        await this.timelines.append({
          conversationId: conversation.id,
          runId: run.id,
          role: TimelineRole.User,
          kind: TimelineKind.Text,
          payload: userMessagePayload({
            message: input.message,
            ...(input.attachments && input.attachments.length > 0
              ? { attachments: [...input.attachments] }
              : {}),
          } as AgentChatDto),
          startedAt: now,
          finishedAt: now,
        })
      } else if (input.card) {
        // 时间线**先写系统卡**：刷新 / 回看时"父为什么突然继续了"有据可查
        await this.timelines.append({
          conversationId: conversation.id,
          runId: run.id,
          role: TimelineRole.System,
          kind: TimelineKind.Status,
          payload: input.card,
          startedAt: now,
          finishedAt: now,
        })
      }

      const streamId = `${run.id}-${Date.now()}-queue`
      await this.runs.setActiveStream(run.id, streamId)
      await this.streamStore.startRun(run.id, {
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
          isKnownTool: (toolKey) => Boolean(this.toolRegistry.get(toolKey)),
        },
      )
      let stepCount = 0
      let lastProgressAt = 0
      ensureHeartbeat()

      try {
        unsubscribeStop = await this.streamStore.subscribeStop(run.id, () => abort.abort())
      } catch (error) {
        this.logger.warn('ai.stream.stop_subscribe_failed', {
          runId: run.id,
          reason: error instanceof Error ? error.message : String(error),
        })
      }

      // 先把"这一轮的身份"写进输出记录：续流连接的第一块就能拿到 runId（含来源）
      rev = await emit({
        type: 'data-run',
        data: {
          runId: run.id,
          conversationId: conversation.id,
          agentKey: definition.key,
          origin,
        },
      })
      if (input.card) {
        rev = await emit({
          type: 'data-subagent-completed',
          id: String(input.card.subRunId ?? run.id),
          data: input.card,
        })
      }
      // 输出记录与进度已就绪 → 再通知"新的一轮开始了"：前端收到后立刻接流不会 204
      await this.notifyRunStarted(conversation.id, run.id, origin)

      const requestContext = await this.buildRuntimeContext(
        conversation.id,
        run.id,
        definition,
        userId,
        model,
        {
          fileAccess: conversation.fileAccess,
          workspaceConversationId: conversation.rootConversationId ?? conversation.id,
          abortSignal: abort.signal,
          systemPrompt: await this.resolveSystemPrompt(conversation, run.id, definition),
          isAdmin: input.isAdmin,
        },
      )
      const agent = this.requireMastra().getAgent(definition.key)
      const memoryThread = await this.ensureAgentThread(conversation.id, userId)
      // 排队 / 唤醒可能发生在进程重启之后：thread 被清空时先用时间线回灌一份对话骨架
      await this.rehydrateThreadIfEmpty(conversation.id, userId)

      armFirstTokenTimer()
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
        model: modelInstance as never,
        runId: run.engineRunId,
        closeOnSuspend: true,
        prepareStep: this.buildPrepareStep(built.snapshot.windowTokens),
      })
      const uiStream = createLiveUsage({ runId: run.id, startedAt }).wrap(output)
      const reader = (uiStream as unknown as ReadableStream<UiChunkLike>).getReader()
      for (;;) {
        const next = await reader.read()
        if (next.done) break
        const chunk = next.value
        if (
          chunk.type === 'text-delta' ||
          chunk.type === 'reasoning-delta' ||
          chunk.type === 'tool-input-available'
        ) {
          if (!firstTokenSeen) {
            firstTokenSeen = true
            stopFirstTokenTimer()
          }
        }
        if (chunk.type === 'data-tool-call-suspended') suspended = true
        const recordedChunk = normalizeSuspendedChunk(chunk, run.id)
        const outgoing = toClientToolChunk(recordedChunk)
        try {
          await this.streamStore.waitForReplayGate(run.id)
          await recorder.consume(recordedChunk)
          rev = await emit(outgoing)
          if (chunk.type === 'start-step') stepCount += 1
          const nowMs = Date.now()
          if (nowMs - lastProgressAt >= STREAM_PROGRESS_THROTTLE_MS) {
            lastProgressAt = nowMs
            await this.streamStore.patchRun(run.id, {
              stage:
                chunk.type === 'tool-input-available'
                  ? `tool:${chunk.toolName ?? ''}`
                  : 'generating',
              rev,
              step: stepCount,
              heartbeatAt: new Date().toISOString(),
            })
            await this.runs.touchHeartbeat(run.id)
          }
        } catch (error) {
          this.logger.warn('ai.stream.record_failed', {
            runId: run.id,
            reason: error instanceof Error ? error.message : String(error),
          })
        }
        // 挂起后 Mastra 的流不会自己结束（它在等 resume）：主动收流，按 suspended 收尾
        if (suspended) break
      }

      if (abort.signal.aborted) {
        await recorder.flushPending()
        throw new Error(firstTokenTimedOut ? 'first_token_timeout' : 'stream_aborted_by_user')
      }
      await recorder.flushPending()

      if (suspended) {
        const suspendSteps = (await readStreamSteps(output)) as unknown as StepLike[]
        const persistedSuspend = await recorder.finish(suspendSteps)
        const suspendUsage = await this.rollUpUsage(
          run.id,
          toUsageRecord(await readStreamUsage(output)),
        )
        await this.runs.suspend(run.id, {
          usage: suspendUsage,
          stepCount: suspendSteps.length,
          toolCallCount: persistedSuspend.toolCallCount,
          durationMs: Date.now() - startedAt,
        })
        await this.runs.setActiveStream(run.id, null)
        stopHeartbeat()
        await emit({
          type: 'data-run-suspended',
          data: { runId: run.id, conversationId: conversation.id },
        })
        this.logger.log('ai.stream.suspended', {
          conversationId: conversation.id,
          runId: run.id,
          origin,
          stepCount: suspendSteps.length,
        })
        return 'succeeded'
      }

      const steps = (await readStreamSteps(output)) as unknown as StepLike[]
      const persisted = await recorder.finish(steps)
      // 记忆抽取只属于用户消息（子 agent 唤醒不是用户说的）；命名已与主回答并行跑完
      const extracted =
        origin === 'user' && this.memoryExtractor
          ? await this.memoryExtractor.maybeExtract({
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
      const usageBase = await this.rollUpUsage(run.id, toUsageRecord(await readStreamUsage(output)))
      let usage = usageBase
      for (const extra of [title?.usage, extracted?.usage]) {
        if (extra) usage = { ...usage, ...mergeUsage(usage, extra) }
      }
      const durationMs = Date.now() - startedAt
      await this.runs.finish(run.id, {
        status: RunStatus.Succeeded,
        usage,
        stepCount: steps.length,
        toolCallCount: persisted.toolCallCount,
        durationMs,
        firstTokenMs:
          recorder.firstOutputAtMs === null ? null : recorder.firstOutputAtMs - startedAt,
      })
      await this.runs.setActiveStream(run.id, null)
      await this.conversationRepo.accumulate(conversation.id, totalTokensOf(usage))
      await emit({
        type: 'data-run-usage',
        data: {
          runId: run.id,
          usage,
          stepCount: steps.length,
          toolCallCount: persisted.toolCallCount,
          durationMs,
        },
      })
      this.logger.log('ai.stream.queued_turn_succeeded', {
        conversationId: conversation.id,
        runId: run.id,
        origin,
        stepCount: steps.length,
        toolCallCount: persisted.toolCallCount,
        durationMs,
      })
      return 'succeeded'
    } catch (error) {
      const durationMs = Date.now() - startedAt
      const reason = error instanceof Error ? error.message : String(error)
      if (firstTokenTimedOut) {
        const mapped = new ModelNoResponseError(this.config.firstTokenTimeoutMs)
        await this.runs.finish(run.id, {
          status: RunStatus.Failed,
          usage: await this.rollUpUsage(run.id, null),
          errorCode: String(AppErrorCodes.ModelNoResponse),
          errorStage: RunErrorStage.Model,
          errorMessage: mapped.message,
          errorDetail: { raw: reason, timeoutMs: this.config.firstTokenTimeoutMs },
          durationMs,
        })
        await this.timelines.append({
          conversationId: conversation.id,
          runId: run.id,
          role: TimelineRole.System,
          kind: TimelineKind.Error,
          payload: {
            message: mapped.message,
            stage: RunErrorStage.Model,
            reason: 'first_token_timeout',
          },
          finishedAt: new Date(),
        })
        await this.cascadeStop(run.id, conversation.id)
        if (origin === 'user') await this.writeFallbackTitle(conversation, input.message)
        this.logger.error('ai.stream.queued_turn_first_token_timeout', {
          runId: run.id,
          timeoutMs: this.config.firstTokenTimeoutMs,
        })
        return 'failed'
      }
      if (abort.signal.aborted) {
        await this.runs.finish(run.id, { status: RunStatus.Canceled, durationMs })
        await this.timelines.append({
          conversationId: conversation.id,
          runId: run.id,
          role: TimelineRole.System,
          kind: TimelineKind.Status,
          payload: {
            status: RunStatus.Canceled,
            reason: 'user_stopped',
            operator: userId,
            origin,
          },
          finishedAt: new Date(),
        })
        await this.cascadeStop(run.id, conversation.id)
        this.logger.log('ai.stream.queued_turn_canceled', { runId: run.id, origin, durationMs })
        return 'canceled'
      }
      const mapped = classifyModelError(error)
      await this.runs.finish(run.id, {
        status: RunStatus.Failed,
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
        payload: { message: mapped.message, stage: RunErrorStage.Model, origin },
        finishedAt: new Date(),
      })
      await this.cascadeStop(run.id, conversation.id)
      if (origin === 'user') await this.writeFallbackTitle(conversation, input.message)
      this.logger.error('ai.stream.queued_turn_failed', { runId: run.id, origin, reason })
      return 'failed'
    } finally {
      stopHeartbeat()
      stopFirstTokenTimer()
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
      try {
        await this.streamStore.clearRun(run.id)
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
    this.writeAgUiChunk(response, chunk, { threadId: conversationId, runId: item.id })
    this.writeAgUiChunk(
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
      abortSignal?: AbortSignal
      systemPrompt?: string
      isAdmin?: boolean
      /** 会话选的沙箱文件权限（只读 / 可写）：只影响沙箱内写权限，逃不出沙箱 */
      fileAccess?: 'read-only' | 'workspace-write'
      /** 工作区/文件归属的根会话（子会话共享父工作区） */
      workspaceConversationId?: string
    } = {},
  ): Promise<RequestContext> {
    // 子 agent 工具面 = 父 agent 授权面 ∩ 全部 − 委派类 − child:deny，**再按本次身份过滤作用域**
    // （admin 工具不因父 agent 声明了就对普通用户触发的那一轮可见）
    const caller = {
      isAdmin: options.isAdmin ?? false,
      userId,
      rootAgentKey: definition.key,
    }
    const childToolbox = await this.toolRegistry.authorizedChildToolbox(definition.tools, caller)

    const envelope: AgentRuntimeEnvelope = {
      conversationId,
      workspaceConversationId: options.workspaceConversationId ?? conversationId,
      parentRunId,
      triggeredBy: userId,
      // 身份由编排层给（控制器从鉴权上下文取）：工具作用域判定用它，**不由模型决定**
      isAdmin: options.isAdmin ?? false,
      fileAccess: options.fileAccess ?? 'workspace-write',
      depth: 0,
      agentKey: definition.key,
      // 根 agent key：子 agent 沿用父的判定（作用域按它算）
      rootAgentKey: definition.key,
      model,
      // 子 agent 的工具面 = 父 agent 的授权面 ∩ 全部 − 委派类 − child:deny
      // （"子助手有你的全部工具"里的"你的"指父 agent 被授权的那一份，不是注册机全量）
      childToolbox,
      skills: await this.skillLoader.resolve(definition.skills),
      ...(options.systemPrompt ? { systemPrompt: options.systemPrompt } : {}),
      ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
    }
    // 与 `RequestContext` 的读写收在适配器里（主体不认识 Mastra 的这个词）
    return toRequestContext(envelope)
  }

  /**
   * 会话**开局**的运行环境片段（操作系统 + 当前时间）；非首轮返回 `undefined`。
   *
   * 「首轮」= 这个会话还没有完成过任何一轮（`turnCount === 0`）。两个刻意的取舍：
   * 1. **只在首轮注入**：系统提示词是请求前缀，每轮塞一个新时间戳会让提供方的前缀缓存
   *    每轮失效（本工程专门统计缓存命中，不能自己把它打掉）；需要精确时间时模型用
   *    `bash` 自己取。中途某一轮失败重试仍是 `turnCount === 0`，环境会重新注入 —— 无妨。
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
    const previous = await this.timelines.latestSystemPrompt(conversation.id)
    if (previous && previous.agentKey === definition.key) return previous.text

    const environment = this.renderEnvironment(conversation)
    const systemPrompt = environment
      ? `${definition.instructions}\n\n${environment}`
      : definition.instructions

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
    })
    return systemPrompt
  }

  private renderEnvironment(conversation: ConversationEntity): string | undefined {
    if (conversation.turnCount > 0) return undefined
    try {
      return this.prompts.renderPartial('partials/environment', buildEnvironmentData())
    } catch (error) {
      this.logger.warn('ai.environment.render_failed', {
        conversationId: conversation.id,
        reason: error instanceof Error ? error.message : String(error),
      })
      return undefined
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
    const children = await this.runs.listChildUsages(runId)
    if (children.length === 0) return own
    const subAgents = mergeUsage(...children)
    return { ...own, subAgents, ...mergeUsage(own, subAgents) }
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
 * - 重连：快照 + `sinceRev` 增量（不再整轮重放），没有进行中的流则回 204。
 */
export const STREAM_HEARTBEAT_MS = 15_000
export const STREAM_PROGRESS_THROTTLE_MS = 1_000

/** 流式片段的最小结构（录制器与转发共用） */
interface UiChunkLike {
  type?: string
  toolName?: string
  messageId?: string
  [key: string]: unknown
}

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
  // AG-UI 不认 vercel 的协议头（写了只会在排查时误导，手册 §8 坑 12）；只关网关缓冲
  'x-accel-buffering': 'no',
}

const sseFrame = (chunk: unknown): string => `data: ${JSON.stringify(chunk)}\n\n`

/**
 * 向 SSE 响应写一帧（**客户端断开时不抛错**）。
 *
 * 为什么必须包一层：`ServerResponse.write()` 在 socket 已经关闭 / 响应已经 end 时会抛
 * 「Connection is closed.」。此前它直接出现在**心跳定时器**里 —— 定时器回调抛异常 = 进程级
 * `uncaughtException` = `process.exit(1)`，于是"一个客户端刷新页面"就能把整个服务重启，
 * 正在跑的其它会话跟着全丢（排查很久才定位到）。写失败只说明这一帧没人收，返回 false 即可。
 */
const writeSse = (response: StreamResponseLike, chunk: string): boolean => {
  if (response.writableEnded) return false
  try {
    response.write(chunk)
    return true
  } catch {
    return false
  }
}

/** 结束 SSE 响应（幂等；客户端已断开时静默） */
const endSse = (response: StreamResponseLike): void => {
  if (response.writableEnded) return
  try {
    response.end()
  } catch {
    // 连接已经没了：没有可收尾的对象
  }
}
