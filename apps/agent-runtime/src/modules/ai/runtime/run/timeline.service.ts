import { Inject, Injectable } from '@nestjs/common'
import type { PageQueryResult } from '@repo/kits'
import {
  TimelineKind,
  TimelineRole,
  type AgentTimelineItemModel,
  type AgentTimelineListDto,
} from '@repo/shared'
import { AgentConversationService } from '../conversation/conversation.service.js'
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

  /**
   * 追加控制面状态事件（改名 / 文件权限变更）。
   *
   * timeline 的写方是 runtime：main 不再自己插 timeline，改名 / 改权限后调内部接口。
   * 调用方已做归属校验，这里只负责落一条 system/status 事件。
   */
  async appendStatus(conversationId: string, payload: Record<string, unknown>): Promise<void> {
    await this.timelines.append({
      conversationId,
      role: TimelineRole.System,
      kind: TimelineKind.Status,
      payload,
      finishedAt: new Date(),
    })
  }
}
