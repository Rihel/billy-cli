import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common'
import { ConversationEntity, ConversationRunQueueEntity } from '@repo/db'
import { Db, requestContext } from '@repo/kits'
import type {
  AgentRunQueueItemModel,
  AgentRunQueueListDto,
  AgentRunQueueRemoveDto,
  AgentRunQueueUpdateDto,
} from '@repo/shared'

/** 会话输入框上方待执行队列的读取 / 编辑 / 删除（只操作 source=user 的 queued 项） */
@Injectable()
export class AgentRunQueueService {
  constructor(@Inject(Db) private readonly db: Db) {}

  async list(input: AgentRunQueueListDto): Promise<AgentRunQueueItemModel[]> {
    await this.requireOwned(input.conversationId)
    const rows = await this.repo().find({
      where: { conversationId: input.conversationId, status: 'queued' },
      order: { priority: 'ASC', createdAt: 'ASC' },
    })
    return rows.map(toItem)
  }

  async update(input: AgentRunQueueUpdateDto): Promise<AgentRunQueueItemModel> {
    await this.requireOwned(input.conversationId)
    const row = await this.requireUserItem(input.conversationId, input.queueId)
    const payload = { ...row.payload, message: input.message }
    await this.repo().update(row.id, { payload })
    return toItem(Object.assign(row, { payload }))
  }

  async remove(input: AgentRunQueueRemoveDto): Promise<{ removed: boolean }> {
    await this.requireOwned(input.conversationId)
    const row = await this.requireUserItem(input.conversationId, input.queueId)
    await this.repo().update(row.id, { status: 'canceled', finishedAt: new Date() })
    return { removed: true }
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

const toItem = (row: ConversationRunQueueEntity): AgentRunQueueItemModel => {
  const payload = row.payload ?? {}
  const message = typeof payload.message === 'string' ? payload.message : null
  const name = typeof payload.name === 'string' ? payload.name : null
  const result = typeof payload.result === 'string' ? payload.result : null
  return {
    id: row.id,
    source: row.source === 'subagent' ? 'subagent' : 'user',
    status: row.status,
    message,
    subAgentName: name,
    resultSummary: result ? result.slice(0, 200) : null,
    createdAt: row.createdAt,
  }
}
