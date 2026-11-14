import { Inject, Injectable } from '@nestjs/common'
import type { PageQueryResult } from '@repo/kits'
import type { AgentTimelineItemModel, AgentTimelineListDto } from '@repo/shared'
import { AgentConversationService } from './conversation.service.js'
import { TimelineRepository } from './timeline.repository.js'

/**
 * 时间线服务：查询会话里按顺序发生的事。
 *
 * 只读 + 只追加（写入由运行时在跑的过程中调用仓储完成）。
 * 查询前一律做归属校验：会话不是当前用户的 → 3304。
 */
@Injectable()
export class AgentTimelineService {
  constructor(
    @Inject(TimelineRepository) private readonly timelines: TimelineRepository,
    @Inject(AgentConversationService) private readonly conversations: AgentConversationService,
  ) {}

  async list(
    userId: string,
    input: AgentTimelineListDto,
  ): Promise<PageQueryResult<AgentTimelineItemModel>> {
    await this.conversations.requireOwned(userId, input.conversationId)
    return this.timelines.list(input)
  }
}
