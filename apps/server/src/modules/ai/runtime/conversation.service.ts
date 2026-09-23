import { Inject, Injectable } from '@nestjs/common'
import { AppLogger } from '@repo/kits'
import {
  RunStatus,
  TimelineKind,
  TimelineRole,
  type AgentConversationCreateDto,
  type AgentConversationIdDto,
  type AgentConversationListDto,
  type AgentConversationModel,
} from '@repo/shared'
import type { PageQueryResult } from '@repo/kits'
import type { ConversationEntity } from '../../../database/entities/conversation-entity.js'
import { ConversationNotFoundError } from '../core/ai.errors.js'
import { AGENT_REGISTRY } from '../core/ai.registry.js'
import type { AgentRegistry } from '../core/ai.types.js'
import {
  ConversationRepository,
  toConversationModel,
} from './conversation.repository.js'
import { RunRepository } from './run.repository.js'
import { TimelineRepository } from './timeline.repository.js'

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
    return toConversationModel(await this.requireOwned(userId, input.conversationId))
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
    this.logger.log('ai.conversation.removed', {
      conversationId: input.conversationId,
      canceledRuns: canceled,
      operator: userId,
    })
  }
}
