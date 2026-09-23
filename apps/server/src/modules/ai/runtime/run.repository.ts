import { Inject, Injectable } from '@nestjs/common'
import { Db, type PageQueryResult } from '@repo/kits'
import { AppErrorCodes, RunStatus, type AgentRunModel } from '@repo/shared'
import { In, IsNull, type DeepPartial } from 'typeorm'
import { jsonbPatch } from './jsonb.js'
import { RunEntity } from '../../../database/entities/run-entity.js'

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
        status: In([RunStatus.Pending, RunStatus.Running]),
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
      { conversationId, status: In([RunStatus.Pending, RunStatus.Running]) },
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
  ): Promise<Array<{ id: string; conversationId: string }>> {
    const repo = await this.repo()
    const rows = await repo
      .createQueryBuilder('r')
      .select(['r.id AS id', 'r.conversation_id AS "conversationId"'])
      .where('r.status = :status', { status: RunStatus.Running })
      .andWhere('(r.heartbeatAt < :heartbeatBefore OR r.startedAt < :startedBefore)', {
        heartbeatBefore,
        startedBefore,
      })
      .limit(limit)
      .getRawMany<{ id: string; conversationId: string }>()
    return rows
  }

  /**
   * 条件 UPDATE：抢到执行权（影响行数 1）才继续处置 —— 返回影响行数。
   *
   * **判据必须与 {@link findStale} 完全一致**（心跳过期 OR 总时长超限）；
   * 早先只判心跳，导致"心跳还在跳但总时长超限"的卡死运行永远处置不掉（测试抓出来的）。
   */
  async markTimeout(id: string, heartbeatBefore: Date, startedBefore: Date): Promise<number> {
    const repo = await this.repo()
    const result = await repo
      .createQueryBuilder()
      .update(RunEntity)
      .set({
        status: RunStatus.Failed,
        errorStage: 'timeout',
        errorCode: String(AppErrorCodes.RunTimeout),
        errorMessage: '本次对话超时（服务端看门狗判定），请重试',
        finishedAt: new Date(),
      })
      .where('id = :id', { id })
      .andWhere('status = :status', { status: RunStatus.Running })
      .andWhere('(heartbeatAt < :heartbeatBefore OR startedAt < :startedBefore)', {
        heartbeatBefore,
        startedBefore,
      })
      .execute()
    return result.affected ?? 0
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
}
