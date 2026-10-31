import { Inject, Injectable } from '@nestjs/common'
import { Db, type PageQueryResult } from '@repo/kits'
import {
  AppErrorCodes,
  RunErrorStage,
  RunStatus,
  type AgentRunModel,
  type AgentUsageBucketModel,
  type AgentUsageDailyModel,
  type AgentUsageSummaryModel,
} from '@repo/shared'
import { In, IsNull, LessThan, type DeepPartial } from 'typeorm'
import { jsonbPatch } from './jsonb.js'
import { RunEntity } from '../../../database/entities/run-entity.js'


/** SQL 聚合返回的数字列可能是 bigint 字符串（pg 驱动行为），统一用 Number 收口 */
type Numeric = number | string

interface UsageTotalsRow {
  runs: Numeric
  succeeded: Numeric
  failed: Numeric
  canceled: Numeric
  interrupted: Numeric
  totalTokens: Numeric
  inputTokens: Numeric
  outputTokens: Numeric
  cacheReadTokens: Numeric
  reasoningTokens: Numeric
  durationMs: Numeric
  avgDurationMs: Numeric
  avgFirstTokenMs: Numeric
  steps: Numeric
  toolCalls: Numeric
}

interface UsageDailyRow {
  date: string
  runs: Numeric
  totalTokens: Numeric
  inputTokens: Numeric
  outputTokens: Numeric
}

interface UsageBucketRow {
  key: string | null
  runs: Numeric
  totalTokens: Numeric
}

/** 进程重启后遗留 run 的终态说明（用户可见：明确告诉他"重试就行"，不是他的错） */
const INTERRUPTED_RUN_MESSAGE = '服务重启，这一轮已中断，请重试'

/**
 * 看门狗判超时的两条判据（`findStale` 与 `markTimeout` 共用，含义完全不同）：
 * - `stale_heartbeat`：长时间没有心跳 —— 进程 / 容器 / 网络已经没了，或者心跳写库一直失败；
 * - `run_timeout`：心跳还在跳，但单轮总时长超限 —— 真的跑太久。
 * 混成一个 3310 会让"重启"与"模型太慢"无从区分（fuzi 现场就是这么被误读的）。
 */
export type TimeoutReason = 'stale_heartbeat' | 'run_timeout'

/** 实体 → 对外模型 */
const toModel = (record: RunEntity): AgentRunModel => ({
  id: record.id,
  conversationId: record.conversationId,
  parentRunId: record.parentRunId,
  depth: record.depth,
  toolCallId: record.toolCallId,
  agentKey: record.agentKey,
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

/** 终态收尾参数 */
export interface FinishRunInput {
  status: string
  usage?: Record<string, unknown> | null
  stepCount?: number
  toolCallCount?: number
  durationMs?: number | null
  firstTokenMs?: number | null
  errorCode?: string | null
  errorStage?: string | null
  errorMessage?: string | null
  errorDetail?: Record<string, unknown> | null
}

@Injectable()
export class RunRepository {
  constructor(@Inject(Db) private readonly db: Db) {}

  private async repo() {
    return this.db.getRepository(RunEntity)
  }

  async create(data: DeepPartial<RunEntity>): Promise<AgentRunModel> {
    const repo = await this.repo()
    return toModel(await repo.save(repo.create(data)))
  }

  /**
   * 该会话是否有进行中的**一轮**（pending / running）。
   *
   * 只看**根 run**（`parent_run_id IS NULL`）：子 agent 的 run 不是"一轮"，
   * 它在跑不代表这一轮还没结束 —— 恰恰相反，父在等它。
   */
  async findActive(conversationId: string): Promise<RunEntity | null> {
    const repo = await this.repo()
    return repo.findOne({
      where: {
        conversationId,
        parentRunId: IsNull(),
        status: In([RunStatus.Pending, RunStatus.Running, RunStatus.Suspended]),
      },
      order: { createdAt: 'DESC' },
    })
  }

  /**
   * 该用户**当前进行中的根运行**（跨会话找最近一条）。
   *
   * 用途：断线重连时不要求客户端报出 runId —— 刷新页面、换设备、甚至换浏览器都能接回
   * 正在跑的那一轮（真相在库里，不在浏览器内存里）。`order by created_at desc` 取最近一条：
   * 同一用户理论上可能有多个会话各有一轮在跑（不同标签页），接回最近发起的那一个。
   */
  async findActiveByUser(userId: string): Promise<RunEntity | null> {
    const repo = await this.repo()
    return repo.findOne({
      where: {
        triggeredBy: userId,
        parentRunId: IsNull(),
        status: In([RunStatus.Pending, RunStatus.Running, RunStatus.Suspended]),
      },
      order: { createdAt: 'DESC' },
    })
  }

  /** 幂等查：某个父工具调用是否已经建过子 run（崩溃恢复重放时复用它，不重复扣费） */
  async findChildByToolCall(
    parentRunId: string,
    toolCallId: string,
  ): Promise<RunEntity | null> {
    const repo = await this.repo()
    return repo.findOne({ where: { parentRunId, toolCallId } })
  }

  /** 某个父 run 已创建的子 run 个数（配额守卫用：按"这一次问答里造了几个子助手"算） */
  async countChildren(parentRunId: string): Promise<number> {
    const repo = await this.repo()
    return repo.count({ where: { parentRunId } })
  }

  /**
   * 某个父 run 下**全部子 run 的消耗**（收尾时逐字段加总进父的 `usage.subAgents`）。
   *
   * 只取 usage 列：父子计费都要算，但子 run 的步级明细留在时间线里，不在这里拉。
   */
  async listChildUsages(parentRunId: string): Promise<Array<Record<string, unknown> | null>> {
    const repo = await this.repo()
    const rows = await repo.find({
      where: { parentRunId },
      select: { id: true, usage: true },
    })
    return rows.map((row) => row.usage)
  }

  /** 某个父 run 的子 run 列表（审计页的树形展示用） */
  async listChildren(parentRunId: string): Promise<AgentRunModel[]> {
    const repo = await this.repo()
    const rows = await repo.find({
      where: { parentRunId },
      order: { createdAt: 'ASC' },
    })
    return rows.map(toModel)
  }

  async findEntity(id: string): Promise<RunEntity | null> {
    const repo = await this.repo()
    return repo.findOneBy({ id })
  }

  /** 起跑：置 running + 开始时间 + 心跳 */
  async markRunning(id: string, engineRunId?: string): Promise<void> {
    const repo = await this.repo()
    await repo.update(
      { id },
      {
        status: RunStatus.Running,
        engineRunId: engineRunId ?? null,
        startedAt: new Date(),
        heartbeatAt: new Date(),
      },
    )
  }

  /**
   * 把 Mastra 的 **engine runId** 回写到我们这一行（durable 快照靠它找到宿主）。
   *
   * 为什么要单独一个方法而不是复用 `markRunning`：那个会把 `started_at` / `heartbeat_at` 重置成现在，
   * 而这里只是补一个标识，**不能动真实开始时间**（耗时统计要准）。
   */
  async attachEngineRun(id: string, engineRunId: string): Promise<void> {
    const repo = await this.repo()
    await repo.update({ id }, { engineRunId })
  }

  /** 心跳（运行中定期刷新；恢复与超时判定都看它） */
  async touchHeartbeat(id: string): Promise<void> {
    const repo = await this.repo()
    await repo.update({ id }, { heartbeatAt: new Date() })
  }

  /** 写当前活动流 id（重连与停止用它定位；跑完在收尾里清空） */
  async setActiveStream(id: string, streamId: string | null): Promise<void> {
    const repo = await this.repo()
    await repo.update({ id }, { activeStreamId: streamId })
  }

  /** 写输入快照（送给模型的输入侧证据：模型 / 参数 / 上下文取舍） */
  async saveRequestSnapshot(id: string, snapshot: Record<string, unknown>): Promise<void> {
    const repo = await this.repo()
    await repo.update(
      { id },
      jsonbPatch<RunEntity>({ requestSnapshot: snapshot }),
    )
  }

  /**
   * 挂起：等用户回答工具提问。**不是终态** —— 不写 `finishedAt`，也不清 usage。
   *
   * 挂起期间看门狗不扫它（`findStale` 只找 pending/running）；用户回答走 resume，
   * 放弃则走 stop / cancel。把已经烧掉的 token 先记在账上，别等用户回答才结算。
   */
  async suspend(
    id: string,
    input: { usage?: Record<string, unknown> | null; stepCount?: number; toolCallCount?: number; durationMs?: number },
  ): Promise<void> {
    const repo = await this.repo()
    await repo.update(
      { id },
      jsonbPatch<RunEntity>({
        status: RunStatus.Suspended,
        usage: input.usage ?? null,
        stepCount: input.stepCount ?? 0,
        toolCallCount: input.toolCallCount ?? 0,
        durationMs: input.durationMs ?? null,
      }),
    )
  }

  /** 终态收尾（跑完 / 失败 / 取消 / 中断都走这里） */
  async finish(id: string, input: FinishRunInput): Promise<void> {
    const repo = await this.repo()
    await repo.update(
      { id },
      jsonbPatch<RunEntity>({
        status: input.status,
        usage: input.usage ?? null,
        stepCount: input.stepCount ?? 0,
        toolCallCount: input.toolCallCount ?? 0,
        durationMs: input.durationMs ?? null,
        firstTokenMs: input.firstTokenMs ?? null,
        errorCode: input.errorCode ?? null,
        errorStage: input.errorStage ?? null,
        errorMessage: input.errorMessage ?? null,
        errorDetail: input.errorDetail ?? null,
        finishedAt: new Date(),
      }),
    )
  }

  /**
   * 结束该会话所有进行中的一轮（软删会话前调用）。
   *
   * 说明：本步骤只是把状态落成 `canceled`；真正"掐断正在生成的模型调用"要等
   * 流式端点接入后走 abort（否则这里只是记账）。
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

  /**
   * 找"卡住的"运行：心跳过期，或总时长超限。
   *
   * 只读候选；真正的抢占在下一条的**条件 UPDATE**（多副本并行跑看门狗时，
   * 只有影响行数为 1 的那个副本负责后续处置 —— 天然幂等，不需要分布式锁）。
   */
  async findStale(
    heartbeatBefore: Date,
    startedBefore: Date,
    limit = 50,
  ): Promise<Array<{ id: string; conversationId: string; reason: TimeoutReason }>> {
    const repo = await this.repo()
    /**
     * **必须把 `pending` 也算进来**（踩过的洞）：`startRun` 先插 pending 再置 running，
     * 若中间失败（DB 抖动 / 进程重启），这一行会永远停在 pending —— 早先这里只扫 running，
     * 于是它的会话**永久** 3306，连看门狗都救不回来。
     * 判据里用 `COALESCE(..., created_at)`：pending 行没有 started_at / heartbeat_at，
     * 否则 `NULL < x` 恒为 false，同样永远判不出来。
     *
     * 同时把"是哪条判据命中的"一起选出来：两者含义不同（没人续租 = 进程/网络没了；
     * 总时长超限 = 还在跑但太久），后续处置与复盘都要按这个分。
     */
    const rows = await repo
      .createQueryBuilder('r')
      .select([
        'r.id AS id',
        'r.conversation_id AS "conversationId"',
        `CASE
           WHEN COALESCE(r.heartbeat_at, r.created_at) < :heartbeatBefore THEN 'stale_heartbeat'
           ELSE 'run_timeout'
         END AS "reason"`,
      ])
      .where('r.status IN (:...statuses)', {
        statuses: [RunStatus.Pending, RunStatus.Running],
      })
      .andWhere(
        '(COALESCE(r.heartbeat_at, r.created_at) < :heartbeatBefore OR COALESCE(r.started_at, r.created_at) < :startedBefore)',
        {
          heartbeatBefore,
          startedBefore,
        },
      )
      .setParameters({ heartbeatBefore, startedBefore })
      .limit(limit)
      .getRawMany<{ id: string; conversationId: string; reason: TimeoutReason }>()
    return rows
  }

  /**
   * 条件 UPDATE：抢到执行权（影响行数 1）才继续处置 —— 返回影响行数。
   *
   * **判据必须与 {@link findStale} 完全一致**（心跳过期 OR 总时长超限）；
   * 早先只判心跳，导致"心跳还在跳但总时长超限"的卡死运行永远处置不掉（测试抓出来的）。
   *
   * `counts` 是看门狗从时间线算出来的"已经走到哪了"：超时的行**也**要留下进度，
   * 否则看板上一律显示"0 步 0 工具"，看起来像什么都没发生。
   */
  async markTimeout(
    id: string,
    heartbeatBefore: Date,
    startedBefore: Date,
    input: {
      reason: TimeoutReason
      stepCount: number
      toolCallCount: number
      finishedAt: Date
    },
  ): Promise<number> {
    const repo = await this.repo()
    const message =
      input.reason === 'stale_heartbeat'
        ? '本次对话超时（服务端长时间没有收到该轮的心跳，判定为已无人处理），请重试'
        : '本次对话超时（超过单轮总时长上限），请重试'
    const result = await repo
      .createQueryBuilder()
      .update(RunEntity)
      .set({
        status: RunStatus.Failed,
        errorStage: 'timeout',
        errorCode: String(AppErrorCodes.RunTimeout),
        errorMessage: message,
        finishedAt: input.finishedAt,
        // 进度回填：时间线里真实发生过多少步 / 多少次工具调用
        stepCount: input.stepCount,
        toolCallCount: input.toolCallCount,
      })
      .where('id = :id', { id })
      .andWhere('status IN (:...statuses)', {
        statuses: [RunStatus.Pending, RunStatus.Running],
      })
      .andWhere(
        '(COALESCE(heartbeat_at, created_at) < :heartbeatBefore OR COALESCE(started_at, created_at) < :startedBefore)',
        {
          heartbeatBefore,
          startedBefore,
        },
      )
      .execute()
    return result.affected ?? 0
  }

  /** 数一下这条 run 已经产生了多少步 / 多少次工具调用（看门狗回填进度用） */
  async countProgress(id: string): Promise<{ stepCount: number; toolCallCount: number }> {
    const rows = await this.db.dataSource.query<
      Array<{ stepCount: number | string; toolCallCount: number | string }>
    >(
      `SELECT
         COUNT(*) FILTER (WHERE kind = 'step')::int AS "stepCount",
         COUNT(*) FILTER (WHERE kind = 'tool-call')::int AS "toolCallCount"
       FROM timelines WHERE run_id = $1 AND deleted_at IS NULL`,
      [id],
    )
    const row = rows[0]
    return {
      stepCount: Number(row?.stepCount ?? 0),
      toolCallCount: Number(row?.toolCallCount ?? 0),
    }
  }

  /**
   * 进程重启的**启动清理**：把上一进程遗留的进行中运行标成 `interrupted`。
   *
   * 为什么需要它（单副本场景）：`node --watch` 改一行代码就重启一次，上一进程手里的 run
   * 既没有心跳、也没有人再管它；而看门狗要等 `heartbeatTimeoutMs`（默认 60s）才动手。
   * 这 60 秒里用户重新发消息只会得到 3306「该会话已有正在进行的对话」—— 看起来像"坏了"。
   *
   * 判据里的 `updated_at < since`（`since` = 本次进程启动时刻）是**防误伤**：
   * 启动恢复（durable）若真的接管了某条 run，会写快照、把 `updated_at` 顶到启动之后，
   * 这一条就不会被标中断。多副本部署不走这里（别的副本可能还在正常跑，交给心跳看门狗）。
   *
   * 条件 UPDATE + 影响行数判定：多进程并发启动时也只有抢到的那一个会写（天然幂等）。
   */
  async interruptActiveBefore(
    since: Date,
  ): Promise<Array<{ id: string; conversationId: string }>> {
    const repo = await this.repo()
    const rows = await repo.find({
      where: {
        status: In([RunStatus.Pending, RunStatus.Running]),
        updatedAt: LessThan(since),
      },
      select: { id: true, conversationId: true },
    })

    const interrupted: Array<{ id: string; conversationId: string }> = []
    for (const row of rows) {
      const result = await repo
        .createQueryBuilder()
        .update(RunEntity)
        .set({
          status: RunStatus.Interrupted,
          errorStage: RunErrorStage.Recovery,
          errorMessage: INTERRUPTED_RUN_MESSAGE,
          finishedAt: new Date(),
        })
        .where('id = :id', { id: row.id })
        .andWhere('status IN (:...statuses)', {
          statuses: [RunStatus.Pending, RunStatus.Running],
        })
        .andWhere('updated_at < :since', { since })
        .execute()
      if ((result.affected ?? 0) === 1) interrupted.push(row)
    }
    return interrupted
  }

  /** 某会话的运行记录（按创建时间倒序，分页） */
  async listByConversation(
    conversationId: string,
    page: number,
    size: number,
  ): Promise<PageQueryResult<AgentRunModel>> {
    const repo = await this.repo()
    const [rows, total] = await repo.findAndCount({
      where: { conversationId },
      order: { createdAt: 'DESC' },
      skip: (page - 1) * size,
      take: size,
    })
    return { items: rows.map(toModel), total, page, size }
  }

  /**
   * 控制台「AI 用量」聚合（管理员视角，跨用户）。
   *
   * **只算根 run**（`parent_run_id IS NULL`）：子 agent 的 usage 在收尾时已按字段汇总进
   * 父 run 的 `usage`（§4.7），再按行加一遍就是重复计费。
   *
   * 时间窗按 `COALESCE(started_at, created_at)` 落日；`generate_series` 把没有数据的日期
   * 也补成 0，前端画柱状图时不用自己补空档。
   */
  async usageSummary(days: number): Promise<AgentUsageSummaryModel> {
    const windowStart = "date_trunc('day', now()) - ($1::int - 1) * interval '1 day'"

    const [totalsRow] = await this.db.dataSource.query<UsageTotalsRow[]>(
      `SELECT
         COUNT(*)::int AS "runs",
         COUNT(*) FILTER (WHERE status = 'succeeded')::int AS "succeeded",
         COUNT(*) FILTER (WHERE status = 'failed')::int AS "failed",
         COUNT(*) FILTER (WHERE status = 'canceled')::int AS "canceled",
         COUNT(*) FILTER (WHERE status = 'interrupted')::int AS "interrupted",
         COALESCE(SUM(NULLIF(usage->>'totalTokens', '')::bigint), 0)::bigint AS "totalTokens",
         COALESCE(SUM(NULLIF(usage->>'inputTokens', '')::bigint), 0)::bigint AS "inputTokens",
         COALESCE(SUM(NULLIF(usage->>'outputTokens', '')::bigint), 0)::bigint AS "outputTokens",
         COALESCE(SUM(NULLIF(usage->>'cacheReadTokens', '')::bigint), 0)::bigint AS "cacheReadTokens",
         COALESCE(SUM(NULLIF(usage->>'reasoningTokens', '')::bigint), 0)::bigint AS "reasoningTokens",
         COALESCE(SUM(duration_ms), 0)::bigint AS "durationMs",
         COALESCE(AVG(duration_ms) FILTER (WHERE duration_ms IS NOT NULL), 0)::int AS "avgDurationMs",
         COALESCE(AVG(first_token_ms) FILTER (WHERE first_token_ms IS NOT NULL), 0)::int AS "avgFirstTokenMs",
         COALESCE(SUM(step_count), 0)::bigint AS "steps",
         COALESCE(SUM(tool_call_count), 0)::bigint AS "toolCalls"
       FROM runs
       WHERE parent_run_id IS NULL
         AND COALESCE(started_at, created_at) >= ${windowStart}`,
      [days],
    )

    const dailyRows = await this.db.dataSource.query<UsageDailyRow[]>(
      `WITH days AS (
         SELECT to_char(d, 'YYYY-MM-DD') AS date
         FROM generate_series(
           date_trunc('day', now()) - ($1::int - 1) * interval '1 day',
           date_trunc('day', now()),
           interval '1 day'
         ) AS d
       )
       SELECT days.date,
         COUNT(r.id)::int AS "runs",
         COALESCE(SUM(NULLIF(r.usage->>'totalTokens', '')::bigint), 0)::bigint AS "totalTokens",
         COALESCE(SUM(NULLIF(r.usage->>'inputTokens', '')::bigint), 0)::bigint AS "inputTokens",
         COALESCE(SUM(NULLIF(r.usage->>'outputTokens', '')::bigint), 0)::bigint AS "outputTokens"
       FROM days
       LEFT JOIN runs r
         ON r.parent_run_id IS NULL
        AND to_char(COALESCE(r.started_at, r.created_at), 'YYYY-MM-DD') = days.date
       GROUP BY days.date
       ORDER BY days.date`,
      [days],
    )

    const byAgentRows = await this.db.dataSource.query<UsageBucketRow[]>(
      `SELECT agent_key AS "key",
         COUNT(*)::int AS "runs",
         COALESCE(SUM(NULLIF(usage->>'totalTokens', '')::bigint), 0)::bigint AS "totalTokens"
       FROM runs
       WHERE parent_run_id IS NULL
         AND COALESCE(started_at, created_at) >= ${windowStart}
       GROUP BY agent_key
       ORDER BY "totalTokens" DESC, "runs" DESC
       LIMIT 10`,
      [days],
    )

    const byModelRows = await this.db.dataSource.query<UsageBucketRow[]>(
      `SELECT COALESCE(NULLIF(request_snapshot->>'model', ''), '未记录') AS "key",
         COUNT(*)::int AS "runs",
         COALESCE(SUM(NULLIF(usage->>'totalTokens', '')::bigint), 0)::bigint AS "totalTokens"
       FROM runs
       WHERE parent_run_id IS NULL
         AND COALESCE(started_at, created_at) >= ${windowStart}
       GROUP BY 1
       ORDER BY "totalTokens" DESC, "runs" DESC
       LIMIT 10`,
      [days],
    )

    const num = (value: Numeric | null | undefined): number => Number(value ?? 0)

    const daily: AgentUsageDailyModel[] = dailyRows.map((row) => ({
      date: row.date,
      runs: num(row.runs),
      totalTokens: num(row.totalTokens),
      inputTokens: num(row.inputTokens),
      outputTokens: num(row.outputTokens),
    }))

    const byAgent: AgentUsageBucketModel[] = byAgentRows.map((row) => ({
      key: row.key ?? '未知 agent',
      runs: num(row.runs),
      totalTokens: num(row.totalTokens),
    }))

    const byModel: AgentUsageBucketModel[] = byModelRows.map((row) => ({
      key: row.key ?? '未记录',
      runs: num(row.runs),
      totalTokens: num(row.totalTokens),
    }))

    return {
      days,
      since: `${daily[0]?.date ?? new Date().toISOString().slice(0, 10)}T00:00:00.000Z`,
      totals: {
        runs: num(totalsRow?.runs),
        succeeded: num(totalsRow?.succeeded),
        failed: num(totalsRow?.failed),
        canceled: num(totalsRow?.canceled),
        interrupted: num(totalsRow?.interrupted),
        totalTokens: num(totalsRow?.totalTokens),
        inputTokens: num(totalsRow?.inputTokens),
        outputTokens: num(totalsRow?.outputTokens),
        cacheReadTokens: num(totalsRow?.cacheReadTokens),
        reasoningTokens: num(totalsRow?.reasoningTokens),
        durationMs: num(totalsRow?.durationMs),
        avgDurationMs: num(totalsRow?.avgDurationMs),
        avgFirstTokenMs: num(totalsRow?.avgFirstTokenMs),
        steps: num(totalsRow?.steps),
        toolCalls: num(totalsRow?.toolCalls),
      },
      daily,
      byAgent,
      byModel,
    }
  }
}
