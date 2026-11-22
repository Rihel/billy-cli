import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common'
import { ConversationEntity, ConversationRunQueueEntity } from '@repo/db'
import { Db, requestContext } from '@repo/kits'
import {
  toAgentRunQueueItem,
  type AgentRunQueueItemModel,
  type AgentRunQueueListDto,
  type AgentRunQueueRemoveDto,
  type AgentRunQueueRemoveResultModel,
  type AgentRunQueueUpdateDto,
} from '@repo/shared'
import { AgentCatalogService } from './agent-catalog.service.js'

/** 会话输入框上方待执行队列的读取 / 编辑 / 删除（只操作 source=user 的 queued 项） */
@Injectable()
export class AgentRunQueueService {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(AgentCatalogService) private readonly agents: AgentCatalogService,
  ) {}

  async list(input: AgentRunQueueListDto): Promise<AgentRunQueueItemModel[]> {
    await this.requireOwned(input.conversationId)
    const rows = await this.repo().find({
      where: { conversationId: input.conversationId, status: 'queued' },
      order: { priority: 'ASC', createdAt: 'ASC' },
    })
    return rows.map(toAgentRunQueueItem)
  }

  async update(input: AgentRunQueueUpdateDto): Promise<AgentRunQueueItemModel> {
    await this.requireOwned(input.conversationId)
    await this.requireUserItem(input.conversationId, input.queueId)
    // 写口在 runtime：main 只做归属 / 可见性校验，条件 UPDATE 由 runtime 执行
    return this.agents.updateRunQueue(input)
  }

  async remove(input: AgentRunQueueRemoveDto): Promise<AgentRunQueueRemoveResultModel> {
    await this.requireOwned(input.conversationId)
    await this.requireUserItem(input.conversationId, input.queueId)
    return this.agents.removeRunQueue(input)
  }

  private repo() {
    return this.db.getRepository(ConversationRunQueueEntity)
  }

  private async requireOwned(conversationId: string): Promise<void> {
    const conversation = await this.db
      .getRepository(ConversationEntity)
      .findOne({ where: { id: conversationId } })
    if (!conversation) throw new NotFoundException('会话不存在')
    const identity = requestContext.get('userId') ?? requestContext.get('adminId')
    if (!identity || conversation.userId !== identity)
      throw new ForbiddenException('无权操作该会话')
  }

  private async requireUserItem(
    conversationId: string,
    queueId: string,
  ): Promise<ConversationRunQueueEntity> {
    const row = await this.repo().findOne({ where: { id: queueId, conversationId } })
    if (!row) throw new NotFoundException('队列项不存在')
    if (row.source !== 'user') throw new ForbiddenException('只能修改或删除用户消息')
    if (row.status !== 'queued') throw new ForbiddenException('该队列项已开始执行，不能再修改')
    return row
  }
}
