import { Inject, Injectable } from '@nestjs/common'
import { AppLogger } from '@repo/kits'
import {
  RunStatus,
  TimelineKind,
  TimelineRole,
  type AgentConversationCreateDto,
  type AgentConversationFileAccessDto,
  type AgentConversationIdDto,
  type AgentConversationListDto,
  type AgentConversationModel,
  type AgentConversationRenameDto,
  type AgentInstructionsDto,
  type AgentInstructionsModel,
} from '@repo/shared'
import type { PageQueryResult } from '@repo/kits'
import type { ConversationEntity } from '../../../database/entities/conversation-entity.js'
import { ConversationNotFoundError } from '../core/errors.js'
import { AGENT_REGISTRY } from '../agents/registry.js'
import type { AgentRegistry } from '../agents/types.js'
import {
  ConversationRepository,
  toConversationModel,
} from './conversation.repository.js'
import { RunRepository } from './run.repository.js'
import { TimelineRepository } from './timeline.repository.js'
import { FileService } from '../files/file.service.js'

/**
 * 会话服务：会话的增删查 + 归属校验。
 *
 * 删除规则（硬规则，见设计文档 §4.5）：**只有会话能删、只能软删**；
 * 运行记录与时间线不提供任何删除入口（它们是审计证据）。
 */
@Injectable()
export class AgentConversationService {
  constructor(
    @Inject(ConversationRepository) private readonly conversations: ConversationRepository,
    @Inject(RunRepository) private readonly runs: RunRepository,
    @Inject(TimelineRepository) private readonly timelines: TimelineRepository,
    @Inject(AGENT_REGISTRY) private readonly registry: AgentRegistry,
    @Inject(AppLogger) private readonly logger: AppLogger,
    @Inject(FileService) private readonly files: FileService,
  ) {}

  /** 新建会话（agentKey 未知时由注册表抛 3303） */
  async create(
    userId: string,
    input: AgentConversationCreateDto,
  ): Promise<AgentConversationModel> {
    const definition = this.registry.resolve(input.agentKey)
    const conversation = await this.conversations.create({
      userId,
      agentKey: definition.key,
      title: input.title ?? '',
      // 只决定沙箱内的写权限；"要不要沙箱"是部署配置
      fileAccess: input.fileAccess ?? 'workspace-write',
      lastActiveAt: new Date(),
    })
    this.logger.log('ai.conversation.created', {
      conversationId: conversation.id,
      agentKey: definition.key,
    })
    return conversation
  }

  list(
    userId: string,
    input: AgentConversationListDto,
  ): Promise<PageQueryResult<AgentConversationModel>> {
    return this.conversations.list(userId, input)
  }

  async detail(
    userId: string,
    input: AgentConversationIdDto,
  ): Promise<AgentConversationModel> {
    const conversation = await this.requireOwned(userId, input.conversationId)
    return {
      ...toConversationModel(
        conversation,
        await this.conversations.isRunning(conversation.id),
      ),
      aiFiles: this.files ? await this.files.tree(conversation.id) : undefined,
    }
  }

  /**
   * 重命名会话（用户手动改名）。
   *
   * 与「首轮自动起名」（`runtime/title.service.ts`）的分工：自动名只在**第一轮结束时**生成一次，
   * 而且**用户改过之后不再覆盖**（那条规则由编排层按"标题是否还是当时的自动值"判断，
   * 于是"人改的名字"永远不会被后台悄悄冲掉）。
   *
   * 改名本身**记一条时间线事件**（谁在什么时候把标题从什么改成了什么）——
   * 与删除会话同一口径：会改变用户可见状态的动作都要留痕，审计页看得到。
   */
  async rename(
    userId: string,
    input: AgentConversationRenameDto,
  ): Promise<AgentConversationModel> {
    const conversation = await this.requireOwned(userId, input.conversationId)
    const from = conversation.title
    // 名字没变就不写库、不记事件（避免"点开又确认"刷出一条无意义的审计）
    if (from === input.title) return toConversationModel(conversation)

    await this.conversations.setTitle(input.conversationId, input.title)
    await this.timelines.append({
      conversationId: input.conversationId,
      role: TimelineRole.System,
      kind: TimelineKind.Status,
      payload: {
        reason: 'conversation_renamed',
        from,
        to: input.title,
        operator: userId,
      },
      finishedAt: new Date(),
    })
    this.logger.log('ai.conversation.renamed', {
      conversationId: input.conversationId,
      from,
      to: input.title,
      operator: userId,
    })
    conversation.title = input.title
    return toConversationModel(conversation)
  }

  /**
   * 切换会话的**文件权限**（只读 / 可写）。
   *
   * 与重命名同一口径：改变用户可见状态的动作都留一条时间线，审计页看得到。
   * 它只影响沙箱内的写权限，**不能改变"要不要沙箱"** —— 那是部署配置。
   */
  async setFileAccess(
    userId: string,
    input: AgentConversationFileAccessDto,
  ): Promise<AgentConversationModel> {
    const conversation = await this.requireOwned(userId, input.conversationId)
    if (conversation.fileAccess === input.fileAccess) {
      return toConversationModel(conversation)
    }
    await this.conversations.setFileAccess(input.conversationId, input.fileAccess)
    await this.timelines.append({
      conversationId: input.conversationId,
      role: TimelineRole.System,
      kind: TimelineKind.Status,
      payload: {
        reason: 'conversation_file_access_changed',
        from: conversation.fileAccess,
        to: input.fileAccess,
        operator: userId,
      },
      finishedAt: new Date(),
    })
    this.logger.log('ai.conversation.file_access_changed', {
      conversationId: input.conversationId,
      from: conversation.fileAccess,
      to: input.fileAccess,
      operator: userId,
    })
    conversation.fileAccess = input.fileAccess
    return toConversationModel(conversation)
  }

  /**
   * 归属校验：会话必须属于当前用户。
   *
   * `userId` 一律来自鉴权上下文，**不接受前端传**；不存在与不属于自己返回同一个错误（3304），
   * 避免被用来探测他人会话是否存在。
   */
  async requireOwned(userId: string, conversationId: string): Promise<ConversationEntity> {
    const conversation = await this.conversations.findEntity(conversationId)
    if (!conversation || conversation.userId !== userId) {
      throw new ConversationNotFoundError(conversationId)
    }
    return conversation
  }

  /**
   * **本会话实际用过的系统指令**（渲染后的快照，含首轮运行环境）。
   *
   * 与 `AgentService.instructions`（静态定义）的分工：
   * - 有快照 → 回快照（`source='conversation'`）：这才是"这个会话的模型当时看到的那份"；
   * - 还没有快照（会话刚建、或历史会话早于落快照这一步）→ 退回静态定义（`source='definition'`），
   *   **不编造**一份"看起来像快照"的东西。
   * 归属校验与其它读接口同一道门（不存在 / 不是自己的 → 3304）。
   */
  async instructions(
    userId: string,
    input: AgentInstructionsDto,
  ): Promise<AgentInstructionsModel> {
    const conversation = await this.requireOwned(userId, input.conversationId ?? '')
    const definition = this.registry.resolve(input.agentKey ?? conversation.agentKey)
    const snapshot = await this.timelines.latestSystemPrompt(conversation.id)

    if (snapshot) {
      // 快照里的 agentKey 才是"当时用的是谁"；注册表里还认得出来就带上展示名与描述
      const snapshotAgent = snapshot.agentKey
        ? this.registry.get(snapshot.agentKey)
        : undefined
      return {
        agentKey: snapshot.agentKey ?? definition.key,
        name: snapshotAgent?.name ?? definition.name,
        description: snapshotAgent?.description ?? definition.description,
        instructions: snapshot.text,
        source: 'conversation',
        recordedAt: snapshot.createdAt,
      }
    }

    return {
      agentKey: definition.key,
      name: definition.name,
      description: definition.description,
      instructions: definition.instructions,
      source: 'definition',
      recordedAt: null,
    }
  }

  /**
   * 软删会话（唯一的删除入口）。
   *
   * **删之前先结束在跑的运行**：否则"用户看不到了、模型还在跑、钱还在烧"。
   * 说明：本步骤只把状态落成 `canceled` 并记一条状态事件；真正掐断生成要等流式端点接入后走 abort。
   */
  async remove(userId: string, input: AgentConversationIdDto): Promise<void> {
    await this.requireOwned(userId, input.conversationId)
    const canceled = await this.runs.cancelActive(input.conversationId)
    if (canceled > 0) {
      await this.timelines.append({
        conversationId: input.conversationId,
        role: TimelineRole.System,
        kind: TimelineKind.Status,
        payload: {
          status: RunStatus.Canceled,
          reason: 'conversation_removed',
          operator: userId,
          canceledRuns: canceled,
        },
        finishedAt: new Date(),
      })
    }
    await this.conversations.softDelete(input.conversationId)
    if (this.files) {
      try {
        // 删会话顺手清工作区 + 软删 ai_files + 删 AI 对象；入站对象保留（内容寻址共享）
        await this.files.cleanupConversation(input.conversationId)
      } catch (error) {
        this.logger.error('ai.conversation.cleanup_failed', {
          conversationId: input.conversationId,
          reason: error instanceof Error ? error.message : String(error),
        })
      }
    }
    this.logger.log('ai.conversation.removed', {
      conversationId: input.conversationId,
      canceledRuns: canceled,
      operator: userId,
    })
  }
}
