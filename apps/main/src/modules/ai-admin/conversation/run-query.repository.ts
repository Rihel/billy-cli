import { Inject, Injectable } from '@nestjs/common'
import { RunEntity } from '@repo/db'
import { Db, type PageQueryResult } from '@repo/kits'
import { RunStatus, type AgentRunModel } from '@repo/shared'
import { In, IsNull } from 'typeorm'

/** 实体 → 对外模型（与既有运行列表同一形状） */
export const toRunModel = (record: RunEntity): AgentRunModel => ({
  id: record.id,
  conversationId: record.conversationId,
  taskId: record.taskId,
  parentRunId: record.parentRunId,
  depth: record.depth,
  toolCallId: record.toolCallId,
  agentKey: record.agentKey,
  origin: record.origin,
  triggeredBy: record.triggeredBy,
  requestId: record.requestId,
  status: record.status,
  recoveryCount: record.recoveryCount,
  errorCode: record.errorCode,
  errorStage: record.errorStage,
  errorMessage: record.errorMessage,
  startedAt: record.startedAt ?? undefined,
  finishedAt: record.finishedAt ?? undefined,
  durationMs: record.durationMs,
  firstTokenMs: record.firstTokenMs,
  stepCount: record.stepCount,
  toolCallCount: record.toolCallCount,
  usage: record.usage,
})

/**
 * 运行查询仓储（**只读**，唯一的写是"删会话前取消进行中的一轮"）。
 *
 * `runs` 是审计证据：不提供删除；取消只落终态，不物理删行。
 */
@Injectable()
export class AiRunQueryRepository {
  constructor(@Inject(Db) private readonly db: Db) {}

  private async repo() {
    return this.db.getRepository(RunEntity)
  }

  /**
   * 某会话的运行记录（按创建时间倒序，分页）。
   *
   * 父会话的 run/list 要能看到挂在自己根 run 下的子 run（子 run 现在在子会话里）；
   * 子会话则只列自己的 run。
   */
  async listByConversation(
    conversationId: string,
    page: number,
    size: number,
  ): Promise<PageQueryResult<AgentRunModel>> {
    const repo = await this.repo()
    const roots = await repo.find({
      where: { conversationId, parentRunId: IsNull() },
      select: { id: true },
    })
    const rootIds = roots.map((row) => row.id)
    const [rows, total] = await repo.findAndCount({
      where:
        rootIds.length > 0
          ? [{ conversationId }, { parentRunId: In(rootIds) }]
          : { conversationId },
      order: { createdAt: 'DESC' },
      skip: (page - 1) * size,
      take: size,
    })
    return { items: rows.map(toRunModel), total, page, size }
  }

  async findEntity(id: string): Promise<RunEntity | null> {
    const repo = await this.repo()
    return repo.findOneBy({ id })
  }

  /** 某个父 run 的子 run 列表（审计页的树形展示用） */
  async listChildren(parentRunId: string): Promise<AgentRunModel[]> {
    const repo = await this.repo()
    const rows = await repo.find({ where: { parentRunId }, order: { createdAt: 'ASC' } })
    return rows.map(toRunModel)
  }

  /**
   * 结束该会话所有进行中的一轮（软删会话前调用）。
   *
   * 条件 UPDATE + 影响行数：并发删除同一会话时也只会记一次"取消了几条"。
   * 真正掐断模型生成由 agent-runtime 的流控制负责，这里只落终态。
   */
  async cancelActive(conversationId: string): Promise<number> {
    const repo = await this.repo()
    const result = await repo.update(
      {
        conversationId,
        status: In([RunStatus.Pending, RunStatus.Running, RunStatus.Suspended]),
      },
      { status: RunStatus.Canceled, finishedAt: new Date() },
    )
    return result.affected ?? 0
  }
}
