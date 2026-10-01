import { Inject, Injectable } from '@nestjs/common'
import { Db, pageWith, type PageQueryResult } from '@repo/kits'
import {
  TimelineKind,
  TimelineRole,
  type AgentTimelineItemModel,
  type AgentTimelineListDto,
} from '@repo/shared'
import type { DeepPartial } from 'typeorm'
import { TimelineEntity } from '../../../database/entities/timeline-entity.js'
import { toPlan, type Plan } from './plan.protocol.js'

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
 * 时间线仓储：**只追加**（不提供更新 / 删除；唯一的"改"是崩溃恢复重跑时的 upsert）。
 *
 * seq 分配：同一会话同时只允许一轮进行中（由 `runs` 的部分唯一索引保证），
 * 因此"取 max+1"不存在并发竞争；批量写入时一次分配、按顺序 +1。
 */
@Injectable()
export class TimelineRepository {
  constructor(@Inject(Db) private readonly db: Db) {}

  private async repo() {
    return this.db.getRepository(TimelineEntity)
  }

  /** 会话内下一个序号 */
  async nextSeq(conversationId: string): Promise<number> {
    const repo = await this.repo()
    const row = await repo
      .createQueryBuilder('t')
      .select('MAX(t.seq)', 'max')
      .where('t.conversationId = :conversationId', { conversationId })
      .getRawOne<{ max: number | null }>()
    return Number(row?.max ?? 0) + 1
  }

  /** 追加一条事件（未给 seq 时自动分配） */
  async append(data: DeepPartial<TimelineEntity>): Promise<AgentTimelineItemModel> {
    const repo = await this.repo()
    const conversationId = data.conversationId!
    const seq = data.seq ?? (await this.nextSeq(conversationId))
    return toTimelineModel(await repo.save(repo.create({ ...data, seq, conversationId })))
  }

  /** 追加一批事件（一次分配 seq；TypeORM 的 save 数组自带事务） */
  async appendMany(items: DeepPartial<TimelineEntity>[]): Promise<AgentTimelineItemModel[]> {
    if (items.length === 0) return []
    const conversationId = items[0].conversationId!
    const base = await this.nextSeq(conversationId)
    const repo = await this.repo()
    const rows = items.map((item, index) =>
      repo.create({ ...item, conversationId, seq: base + index }),
    )
    return (await repo.save(rows)).map(toTimelineModel)
  }

  /** 按会话（或某一轮）分页查时间线，按 seq 升序（渲染顺序的权威依据） */
  async list(
    query: AgentTimelineListDto,
  ): Promise<PageQueryResult<AgentTimelineItemModel>> {
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
   * **当前计划** = 该会话里最后一条 `kind='plan'` 事件（append-only，见 `runtime/plan.protocol.ts`）。
   *
   * 这是规划能力的**唯一真相源**：规划工具每次执行时都从这里读出"现在改到哪一版了"
   * （而不是把计划塞进运行时信封的快照里 —— 同一轮内多次工具调用会读到过期版本）。
   * 形状不认识（历史遗留 / 半真半假）时返回 null，调用方当作"还没有计划"处理。
   */
  async latestPlan(conversationId: string): Promise<Plan | null> {
    const repo = await this.repo()
    // **只看根 run**：子 agent 的清单不该顶掉父的当前计划（信封补上以后子 agent 也有 plan 的可能性，
    // 见设计 §5.10「子 agent」缺口 3）。相关子查询走 `runs` 主键，与 `excludeSubAgentEvents` 同一手法。
    const builder = repo
      .createQueryBuilder('t')
      .where('t.conversationId = :conversationId', { conversationId })
      .andWhere('t.kind = :kind', { kind: TimelineKind.Plan })
      .orderBy('t.seq', 'DESC')
      .limit(1)
    excludeSubAgentEvents(builder)
    const row = await builder.getOne()
    return toPlan(row?.payload)
  }

  /**
   * 取某次工具调用的**完整出参原文**（工具结果分页的回取路径，设计 §5.6）。
   *
   * 用途：跨轮 / 跨实例时按 `(会话, toolCallId)` 找到当初那份出参 —— 原文永久保留，
   * 所以"内存里那份被淘汰了""换了个副本"都还能取到页。
   */
  async findToolOutput(conversationId: string, toolCallId: string): Promise<string | null> {
    const repo = await this.repo()
    const row = await repo.findOne({
      where: {
        conversationId,
        toolCallId,
        kind: TimelineKind.ToolResult,
      },
      order: { seq: 'DESC' },
    })
    const output = row?.payload?.output
    if (output === undefined) return null
    // 分页过的结果在时间线里是 `{ __toolPaged, page, data }`（全量在 `data` 里）：
    // 取页要的是**全量原文本身**，所以这里脱一层壳
    const value =
      typeof output === 'object' && output !== null && '__toolPaged' in output
        ? (output as { data?: unknown }).data
        : output
    return JSON.stringify(value ?? null)
  }

  /** 最新一条上下文摘要（组装上下文时用它定位"从哪之后看原文"） */
  async latestSummary(conversationId: string): Promise<TimelineEntity | null> {
    const repo = await this.repo()
    return repo.findOne({
      where: { conversationId, kind: TimelineKind.Summary },
      order: { seq: 'DESC' },
    })
  }

  /**
   * 取某个 seq 区间内的事件（上下文压缩时把这一段交给模型做摘要）。
   *
   * `rootOnly`：排除**子 agent 的事件**——子 agent 的内部过程是审计资料，
   * 不该被当成对话历史回灌给主模型（既浪费窗口也污染上下文，见 §3.14.3）。
   */
  /**
   * 该会话**最后一条系统指令快照**（`kind='system'`）；没有则 null。
   *
   * 两个用途：① 编排层判断"这一轮的提示词和上一轮一样吗"（一样就不重复写，见 §4.10.1）；
   * ② 前端「查看系统指令」回本会话真正用过的原文。
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

  async listRange(
    conversationId: string,
    fromSeq: number,
    toSeq: number,
    options: { rootOnly?: boolean } = {},
  ): Promise<TimelineEntity[]> {
    const repo = await this.repo()
    const builder = repo
      .createQueryBuilder('t')
      .where('t.conversationId = :conversationId', { conversationId })
      .andWhere('t.seq >= :fromSeq', { fromSeq })
      .andWhere('t.seq <= :toSeq', { toSeq })
      .orderBy('t.seq', 'ASC')
    if (options.rootOnly) excludeSubAgentEvents(builder)
    return builder.getMany()
  }

  /** 取摘要之后（或会话开头之后）的事件，用于组装上下文（上限 limit 条，从旧到新） */
  async listSince(
    conversationId: string,
    sinceSeq: number,
    limit: number,
    options: { rootOnly?: boolean } = {},
  ): Promise<TimelineEntity[]> {
    const repo = await this.repo()
    const builder = repo
      .createQueryBuilder('t')
      .where('t.conversationId = :conversationId', { conversationId })
      .andWhere('t.seq > :sinceSeq', { sinceSeq })
      .orderBy('t.seq', 'ASC')
      .limit(limit)
    if (options.rootOnly) excludeSubAgentEvents(builder)
    return builder.getMany()
  }

  /**
   * 某个 run 的**最终助手文本**。
   *
   * 用途：崩溃恢复时复用已成功的子 agent 结论（幂等，不重跑）——
   * 结论只存在于时间线里（没有第二份副本，这是有意的）。
   */
  async lastTextOfRun(runId: string): Promise<string | null> {
    const repo = await this.repo()
    const row = await repo.findOne({
      where: { runId, kind: TimelineKind.Text, role: TimelineRole.Assistant },
      order: { seq: 'DESC' },
    })
    const text = row?.payload?.text
    return typeof text === 'string' ? text : null
  }
}

/**
 * 追加"排除子 agent 事件"的条件（相关子查询，走 `runs` 主键）。
 *
 * 用 `NOT EXISTS` 而不是 `run_id IN (SELECT ...)`：后者会先把全表根 run 拉出来，
 * 事件一多就变成大集合扫描。这里每行只做一次主键命中。
 */
const excludeSubAgentEvents = (builder: {
  andWhere: (sql: string) => unknown
}): void => {
  builder.andWhere(
    'NOT EXISTS (SELECT 1 FROM runs r WHERE r.id = t.run_id AND r.parent_run_id IS NOT NULL)',
  )
}
