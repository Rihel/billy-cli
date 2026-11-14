import { Inject, Injectable } from '@nestjs/common'
import type { ConversationEntity } from '@repo/db'
import { AppLogger, requestContext, type PageQueryResult } from '@repo/kits'
import { RunStatus } from '@repo/shared'
import type {
  AgentConversationCreateDto,
  AgentConversationFileAccessDto,
  AgentConversationIdDto,
  AgentConversationListDto,
  AgentConversationModel,
  AgentConversationRenameDto,
  AgentInstructionsDto,
  AgentInstructionsModel,
  AgentListModel,
  AgentRunDetailModel,
  AgentRunIdDto,
  AgentRunListDto,
  AgentRunModel,
  AgentStatusModel,
  AgentTimelineItemModel,
  AgentTimelineListDto,
  AgentUsageRangeDto,
  AgentUsageSummaryModel,
  AgentUsageSummaryQueryDto,
} from '@repo/shared'
import { AiModelService } from '../../ai-model/index.js'
import { AiUsageService } from '../../ai-usage/index.js'
import { AgentCatalogService } from '../../../agent/agent-catalog.service.js'
import { AiConversationRepository, toConversationModel } from './conversation.repository.js'
import { ConversationNotFoundError, RunNotFoundError } from './errors.js'
import { AiRunQueryRepository, toRunModel } from './run-query.repository.js'
import { AiTimelineQueryRepository } from './timeline-query.repository.js'

/**
 * AI 会话 / 运行 / 时间线的查询与少量写入（**不含 agent loop**）。
 *
 * 身份口径（与既有实现一致，管理员 / 用户双身份都支持）：
 * - 归属一律从 main 的 `requestContext` 取：**前台用户优先，其次管理员**；
 * - 管理员在会话页操作时，会话的 `user_id` 存的就是管理员 id（与历史数据兼容）；
 * - 前端传不了归属，越权与不存在返回同一个错误（3304 / 3305），避免探测他人会话。
 *
 * 写入只有会话 create / rename / file-access / remove 四处；运行与时间线只读
 * （`remove` 的"取消进行中一轮"是状态收尾，不是内容修改）。
 */
@Injectable()
export class AiAdminConversationService {
  constructor(
    @Inject(AiConversationRepository) private readonly conversations: AiConversationRepository,
    @Inject(AiRunQueryRepository) private readonly runs: AiRunQueryRepository,
    @Inject(AiTimelineQueryRepository) private readonly timelines: AiTimelineQueryRepository,
    @Inject(AgentCatalogService) private readonly agents: AgentCatalogService,
    @Inject(AiUsageService) private readonly usage: AiUsageService,
    @Inject(AiModelService) private readonly models: AiModelService,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}

  /**
   * 当前身份 id：**前台用户优先，其次管理员**。
   *
   * 不用 `currentUserId()` / `currentAdminId()`：AI 能力对两端都开放，
   * 而那两个 helper 在另一种身份下会抛错。
   */
  private ownerId(): string {
    const userId = requestContext.get('userId')
    if (userId) return userId
    const adminId = requestContext.get('adminId')
    if (adminId) return adminId
    // 走到这里说明守卫放行了却没写身份（真正的编程错误，而不是"没登录"）
    throw new Error('Authenticated request context is unavailable')
  }

  /** 当前身份是不是管理员（有 userId 就是前台用户，只有 adminId 才是管理员） */
  private isAdminIdentity(): boolean {
    return !requestContext.get('userId') && Boolean(requestContext.get('adminId'))
  }

  /** 新建会话（agentKey 未知时由执行面目录解析出 3303） */
  async create(input: AgentConversationCreateDto): Promise<AgentConversationModel> {
    const ownerId = this.ownerId()
    const agentKey = await this.agents.resolveAgentKey(input.agentKey)
    const conversation = await this.conversations.create({
      userId: ownerId,
      agentKey,
      title: input.title ?? '',
      // 只决定沙箱内的写权限；"要不要沙箱"是部署配置
      fileAccess: input.fileAccess ?? 'workspace-write',
      lastActiveAt: new Date(),
    })
    this.logger.log('ai.conversation.created', {
      conversationId: conversation.id,
      agentKey,
      isAdmin: this.isAdminIdentity(),
    })
    return conversation
  }

  list(input: AgentConversationListDto): Promise<PageQueryResult<AgentConversationModel>> {
    return this.conversations.list(this.ownerId(), input)
  }

  async detail(input: AgentConversationIdDto): Promise<AgentConversationModel> {
    const conversation = await this.requireOwned(input.conversationId)
    const rootId = conversation.rootConversationId ?? conversation.id
    const [running, aiFiles] = await Promise.all([
      this.conversations.isRunning(conversation.id),
      this.conversations.listFileTree(rootId),
    ])
    return { ...toConversationModel(conversation, running), aiFiles }
  }

  /**
   * 重命名会话（用户手动改名）。
   *
   * 名字没变就不写库、不记事件（避免"点开又确认"刷出一条无意义的审计）；
   * 真改了则记一条时间线状态事件（谁在什么时候把标题从什么改成了什么）。
   */
  async rename(input: AgentConversationRenameDto): Promise<AgentConversationModel> {
    const ownerId = this.ownerId()
    const conversation = await this.requireOwnedBy(ownerId, input.conversationId)
    const from = conversation.title
    if (from === input.title) return toConversationModel(conversation)

    await this.conversations.setTitle(input.conversationId, input.title)
    await this.timelines.appendStatus(input.conversationId, {
      reason: 'conversation_renamed',
      from,
      to: input.title,
      operator: ownerId,
    })
    this.logger.log('ai.conversation.renamed', {
      conversationId: input.conversationId,
      from,
      to: input.title,
      operator: ownerId,
    })
    conversation.title = input.title
    return toConversationModel(conversation)
  }

  /**
   * 切换会话的文件权限（只读 / 可写）。
   *
   * 只影响沙箱内的写权限；"要不要沙箱"是部署配置，用户选不到。
   */
  async setFileAccess(input: AgentConversationFileAccessDto): Promise<AgentConversationModel> {
    const ownerId = this.ownerId()
    const conversation = await this.requireOwnedBy(ownerId, input.conversationId)
    if (conversation.fileAccess === input.fileAccess) {
      return toConversationModel(conversation)
    }
    await this.conversations.setFileAccess(input.conversationId, input.fileAccess)
    await this.timelines.appendStatus(input.conversationId, {
      reason: 'conversation_file_access_changed',
      from: conversation.fileAccess,
      to: input.fileAccess,
      operator: ownerId,
    })
    this.logger.log('ai.conversation.file_access_changed', {
      conversationId: input.conversationId,
      from: conversation.fileAccess,
      to: input.fileAccess,
      operator: ownerId,
    })
    conversation.fileAccess = input.fileAccess
    return toConversationModel(conversation)
  }

  /**
   * 软删会话（唯一的删除入口；运行记录与时间线一律保留）。
   *
   * 删之前先结束在跑的运行；子会话随父一起软删；会话文件行一并软删
   * （对象存储 / 工作区的物理清理仍归文件管理侧）。
   */
  async remove(input: AgentConversationIdDto): Promise<void> {
    const ownerId = this.ownerId()
    await this.requireOwnedBy(ownerId, input.conversationId)

    const canceled = await this.runs.cancelActive(input.conversationId)
    if (canceled > 0) {
      await this.timelines.appendStatus(input.conversationId, {
        status: RunStatus.Canceled,
        reason: 'conversation_removed',
        operator: ownerId,
        canceledRuns: canceled,
      })
    }

    const children = await this.conversations.listChildren(input.conversationId)
    for (const child of children) {
      await this.runs.cancelActive(child.id)
      await this.conversations.softDelete(child.id)
    }
    await this.conversations.softDelete(input.conversationId)
    await this.conversations.softDeleteFiles(input.conversationId)

    this.logger.log('ai.conversation.removed', {
      conversationId: input.conversationId,
      canceledRuns: canceled,
      operator: ownerId,
    })
  }

  /** 某个会话的运行列表（**含子 agent 的 run**；归属校验复用会话那一套） */
  async listRuns(input: AgentRunListDto): Promise<PageQueryResult<AgentRunModel>> {
    await this.requireOwned(input.conversationId)
    return this.runs.listByConversation(input.conversationId, input.page, input.size)
  }

  /**
   * 运行详情（输入快照 + 上游错误原文 + 子 agent 列表）：归属校验走
   * "运行 → 会话 → 是否属于当前身份"，不存在与不属于自己返回同一个错误。
   */
  async detailRun(input: AgentRunIdDto): Promise<AgentRunDetailModel> {
    const run = await this.runs.findEntity(input.runId)
    if (!run) throw new RunNotFoundError(input.runId)
    await this.requireOwned(run.conversationId)
    return {
      ...toRunModel(run),
      requestSnapshot: run.requestSnapshot,
      errorDetail: run.errorDetail,
      children: await this.runs.listChildren(run.id),
    }
  }

  /** 时间线列表（按 seq 升序；可只看某一轮） */
  async listTimeline(
    input: AgentTimelineListDto,
  ): Promise<PageQueryResult<AgentTimelineItemModel>> {
    await this.requireOwned(input.conversationId)
    return this.timelines.list(input)
  }

  /** 控制台「AI 用量」汇总（管理员；只读日表，不扫 runs） */
  usageSummary(input: AgentUsageSummaryQueryDto): Promise<AgentUsageSummaryModel> {
    return this.usage.summary(input.days)
  }

  /** 手动回填 AI 用量日表（管理员） */
  async usageRollup(input: AgentUsageRangeDto): Promise<{ days: number }> {
    return { days: await this.usage.backfill(input.from, input.to) }
  }

  /**
   * 能力状态：可用性只看"供应商启用 + 模型启用"的模型，agent 数取执行面注册表。
   *
   * 静态声明只在 runtime 有一份，所以状态直接问执行面（执行面不可用时对话本身也不可用）。
   */
  status(): Promise<AgentStatusModel> {
    return this.agents.status()
  }

  /** agent 清单（`skills: ['*']` 由执行面按库里启用中的技能名现算） */
  listAgents(): Promise<AgentListModel> {
    return this.agents.list()
  }

  /**
   * 系统指令原文：有会话快照回快照（真正送进模型的那份），否则回执行面的静态定义。
   *
   * 静态定义的渲染（agent 规格 + 提示词模板 + 工具 manifest）只在 agent-runtime，
   * 控制面不复制提示词；快照归属校验与其它读接口同一道门。
   */
  async instructions(input: AgentInstructionsDto): Promise<AgentInstructionsModel> {
    if (!input.conversationId) return this.agents.instructions(input)

    const conversation = await this.requireOwned(input.conversationId)
    const agentKey = await this.agents.resolveAgentKey(input.agentKey ?? conversation.agentKey)
    const definition = await this.agents.instructions({ agentKey })
    const snapshot = await this.timelines.latestSystemPrompt(conversation.id)
    if (!snapshot) return definition

    const snapshotAgent = await this.agents.findAgent(snapshot.agentKey)
    return {
      agentKey: snapshot.agentKey ?? definition.agentKey,
      name: snapshotAgent?.name ?? definition.name,
      description: snapshotAgent?.description ?? definition.description,
      instructions: snapshot.text,
      source: 'conversation',
      recordedAt: snapshot.createdAt,
    }
  }

  /** 本轮可选的模型（会话页选择器的数据源） */
  modelsAvailable() {
    return this.models.listAvailable()
  }

  /**
   * 归属校验：会话必须属于当前身份。
   *
   * `ownerId` 一律来自鉴权上下文；不存在与不属于自己返回同一个错误（3304）。
   */
  async requireOwned(conversationId: string): Promise<ConversationEntity> {
    return this.requireOwnedBy(this.ownerId(), conversationId)
  }

  private async requireOwnedBy(
    ownerId: string,
    conversationId: string,
  ): Promise<ConversationEntity> {
    const conversation = await this.conversations.findEntity(conversationId)
    if (!conversation || conversation.userId !== ownerId) {
      throw new ConversationNotFoundError(conversationId)
    }
    return conversation
  }
}
