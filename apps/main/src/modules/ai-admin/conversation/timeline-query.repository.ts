import { Inject, Injectable } from '@nestjs/common'
import { TimelineEntity } from '@repo/db'
import { Db, pageWith, type PageQueryResult } from '@repo/kits'
import { TimelineKind, type AgentTimelineItemModel, type AgentTimelineListDto } from '@repo/shared'

/** 实体 → 对外模型 */
export const toTimelineModel = (record: TimelineEntity): AgentTimelineItemModel => ({
  id: record.id,
  seq: record.seq,
  conversationId: record.conversationId,
  runId: record.runId,
  messageId: record.messageId,
  attempt: record.attempt,
  role: record.role,
  kind: record.kind,
  state: record.state,
  toolKey: record.toolKey,
  toolCallId: record.toolCallId,
  startedAt: record.startedAt ?? undefined,
  finishedAt: record.finishedAt ?? undefined,
  durationMs: record.durationMs,
  usage: record.usage,
  payload: record.payload,
})

/**
 * 时间线查询仓储：**只读**。
 *
 * 写入（运行过程 + 改名 / 改文件权限的控制面事件）全部归 agent-runtime；
 * 控制面需要留痕时调内部 `timeline/status` 接口，不在这里直插。
 */
@Injectable()
export class AiTimelineQueryRepository {
  constructor(@Inject(Db) private readonly db: Db) {}

  private async repo() {
    return this.db.getRepository(TimelineEntity)
  }

  /** 按会话（或某一轮）分页查时间线，按 seq 升序（渲染顺序的权威依据） */
  async list(query: AgentTimelineListDto): Promise<PageQueryResult<AgentTimelineItemModel>> {
    const { conversationId, runId, page, size } = query
    const repo = await this.repo()
    const builder = repo
      .createQueryBuilder('t')
      .where('t.conversationId = :conversationId', { conversationId })
      .orderBy('t.seq', 'ASC')
    if (runId) builder.andWhere('t.runId = :runId', { runId })
    const { data, total } = await pageWith(builder, page, size)
    return { items: data.map(toTimelineModel), total, page, size }
  }

  /**
   * 该会话**最后一条系统指令快照**（`kind='system'`）；没有则 null。
   *
   * 前端「查看系统指令」优先回本会话真正用过的那份原文。
   */
  async latestSystemPrompt(
    conversationId: string,
  ): Promise<{ text: string; agentKey: string | null; createdAt: Date | null } | null> {
    const repo = await this.repo()
    const row = await repo.findOne({
      where: { conversationId, kind: TimelineKind.System },
      order: { seq: 'DESC' },
    })
    const text = row?.payload?.text
    if (typeof text !== 'string' || !text) return null
    return {
      text,
      agentKey: typeof row?.payload?.agentKey === 'string' ? row.payload.agentKey : null,
      createdAt: row?.createdAt ?? null,
    }
  }
}
