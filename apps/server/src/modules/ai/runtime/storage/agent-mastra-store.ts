import {
  MastraCompositeStore,
  WorkflowsStorage,
  type StorageListWorkflowRunsInput,
  type UpdateWorkflowStateOptions,
  type WorkflowRun,
  type WorkflowRuns,
} from '@mastra/core/storage'
import type { WorkflowRunState } from '@mastra/core/workflows'
import { Db, type AppLogger } from '@repo/kits'
import { RunStatus } from '@repo/shared'
import { RunEntity } from '../../../../database/entities/run-entity.js'
import { jsonbPatch } from '../jsonb.js'

/**
 * 存储适配层：**把 Mastra 的运行快照落进我们自己的表**（设计文档 §4.4）。
 *
 * 只实现 `workflows` 这一个域（其余域用不到：记忆不做、agent 配置在代码里）。
 * 快照存 `runs.snapshot`（JSONB，**我们不解析**），运行状态仍由我们自己的运行服务维护 ——
 * 于是"崩溃恢复"需要的快照与"业务真相"在同一行上，不会两处打架。
 *
 * 三条硬规则：
 * 1. **加锁**：Mastra 的 snapshot 是它的内部状态，我们只当黑盒存取，不做业务查询；
 * 2. **不删**：`deleteWorkflowRunById` 是 no-op —— 运行记录与时间线是审计证据，不提供删除；
 * 3. **表由我们的迁移建**：`disableInit`，绝不让 Mastra 去建表（它会建一整套 `mastra_*`）。
 */

/** Mastra 的运行状态 → 我们的业务状态（两套词汇，这里显式映射，避免各写各的） */
const toRunStatus = (status: string | undefined): string | undefined => {
  switch (status) {
    case 'running':
      return RunStatus.Running
    case 'success':
      return RunStatus.Succeeded
    case 'failed':
    case 'tripwire':
    case 'bailed':
      return RunStatus.Failed
    case 'canceled':
      return RunStatus.Canceled
    case 'pending':
    case 'waiting':
    case 'paused':
    case 'suspended':
      return RunStatus.Running
    default:
      return undefined
  }
}

/** 我们的业务状态 → Mastra 的运行状态（list 过滤用） */
const toMastraStatus = (status: string): string | undefined => {
  switch (status) {
    case RunStatus.Running:
      return 'running'
    case RunStatus.Succeeded:
      return 'success'
    case RunStatus.Failed:
      return 'failed'
    case RunStatus.Canceled:
      return 'canceled'
    case RunStatus.Pending:
      return 'pending'
    default:
      return undefined
  }
}

/** 直接引用基类的参数 / 返回类型：StepResult 的泛型参数数量随版本变化，跟着它走最稳 */
type UpdateResultsInput = Parameters<WorkflowsStorage['updateWorkflowResults']>[0]
type UpdateResultsOutput = Awaited<ReturnType<WorkflowsStorage['updateWorkflowResults']>>

export class AgentWorkflowsStorage extends WorkflowsStorage {
  constructor(
    private readonly db: Db,
    /** 注意不能叫 logger：基类已有同名成员，会与继承冲突 */
    private readonly appLogger: AppLogger,
  ) {
    super()
  }

  /**
   * 基类要求的"危险清空"。**刻意不实现**：运行记录与时间线是审计证据，
   * 我们不提供任何清空 / 删除能力（只告警，不动数据）。
   */
  async dangerouslyClearAll(): Promise<void> {
    this.appLogger.warn('ai.storage.clear_ignored', {
      reason: '运行记录与时间线不可清空（审计证据）',
    })
  }

  /** 我们是"整行更新"，不存在并发合并问题 */
  supportsConcurrentUpdates(): boolean {
    return true
  }

  /** 持久化快照（durable agent 的 checkpoint） */
  async persistWorkflowSnapshot(input: {
    workflowName: string
    runId: string
    resourceId?: string
    snapshot: WorkflowRunState
    createdAt?: Date
    updatedAt?: Date
  }): Promise<void> {
    const repo = await this.db.getRepository(RunEntity)
    const status = toRunStatus(input.snapshot?.status as string | undefined)
    const affected = await repo
      .createQueryBuilder()
      .update(RunEntity)
      .set(
        jsonbPatch<RunEntity>({
          snapshot: input.snapshot as unknown as Record<string, unknown>,
          ...(status ? { status } : {}),
        }),
      )
      .where('engine_run_id = :runId', { runId: input.runId })
      .execute()

    if ((affected.affected ?? 0) > 0) return

    // 没有对应的运行记录：说明这是"不经过我们自己编排"的裸运行（例如恢复重跑）。
    // 落一条最小记录，让后续的 list/load 能查到它（宁可留一条来源不明的记录，也不要丢快照）。
    this.appLogger.warn('ai.storage.snapshot_without_run', {
      workflowName: input.workflowName,
      runId: input.runId,
    })
    const created = repo.create({
      conversationId: '',
      agentKey: input.workflowName,
      status: status ?? RunStatus.Running,
      engineRunId: input.runId,
      snapshot: input.snapshot as unknown as Record<string, unknown>,
      startedAt: input.createdAt ?? new Date(),
      heartbeatAt: new Date(),
    })
    await repo.save(created)
  }

  /** 读快照（恢复时用它重建现场） */
  async loadWorkflowSnapshot(input: {
    workflowName: string
    runId: string
  }): Promise<WorkflowRunState | null> {
    const repo = await this.db.getRepository(RunEntity)
    const row = await repo.findOne({ where: { engineRunId: input.runId } })
    if (!row?.snapshot) return null
    return row.snapshot as unknown as WorkflowRunState
  }

  /** 列出运行（恢复流程据此找"在跑的"） */
  async listWorkflowRuns(args: StorageListWorkflowRunsInput = {}): Promise<WorkflowRuns> {
    const repo = await this.db.getRepository(RunEntity)
    const builder = repo
      .createQueryBuilder('r')
      .where('r.engineRunId IS NOT NULL')
      .orderBy('r.createdAt', 'DESC')

    if (args.workflowName) builder.andWhere('r.agentKey = :agentKey', { agentKey: args.workflowName })
    if (args.fromDate) builder.andWhere('r.createdAt >= :fromDate', { fromDate: args.fromDate })
    if (args.toDate) builder.andWhere('r.createdAt <= :toDate', { toDate: args.toDate })
    if (args.status) {
      const mapped = toMastraStatus(String(args.status))
      if (mapped === 'running') {
        builder.andWhere('r.status IN (:...statuses)', {
          statuses: [RunStatus.Running, RunStatus.Pending],
        })
      } else if (mapped) {
        builder.andWhere('r.status = :status', { status: mapped })
      }
    }

    const perPage = typeof args.perPage === 'number' && args.perPage > 0 ? args.perPage : undefined
    const page = typeof args.page === 'number' && args.page > 0 ? args.page : 1
    if (perPage) {
      builder.skip((page - 1) * perPage).take(perPage)
    }

    const [rows, total] = await builder.getManyAndCount()
    return { runs: rows.map((row) => this.toWorkflowRun(row)), total }
  }

  async getWorkflowRunById(input: {
    runId: string
    workflowName?: string
  }): Promise<WorkflowRun | null> {
    const repo = await this.db.getRepository(RunEntity)
    const row = await repo.findOne({
      where: {
        engineRunId: input.runId,
        ...(input.workflowName ? { agentKey: input.workflowName } : {}),
      },
    })
    return row ? this.toWorkflowRun(row) : null
  }

  /**
   * **刻意不实现删除**：运行记录与时间线是复盘/审计证据，不提供删除入口（设计文档 §4.5）。
   * Mastra 在清理生命周期里可能调用它 —— 我们只记一条日志，不动数据。
   */
  async deleteWorkflowRunById(input: {
    runId: string
    workflowName: string
  }): Promise<void> {
    this.appLogger.warn('ai.storage.delete_ignored', {
      runId: input.runId,
      workflowName: input.workflowName,
      reason: '运行记录不可删除（审计证据）',
    })
  }

  /** 更新某个步骤的结果（并进快照的 context，供恢复时续跑） */
  async updateWorkflowResults(
    input: UpdateResultsInput,
  ): Promise<UpdateResultsOutput> {
    const snapshot = (await this.loadWorkflowSnapshot(input)) ?? ({} as WorkflowRunState)
    const context = { ...((snapshot.context ?? {}) as Record<string, unknown>) }
    context[input.stepId] = input.result
    const next = { ...snapshot, context } as WorkflowRunState
    await this.saveSnapshot(input.workflowName, input.runId, next)
    return context as UpdateResultsOutput
  }

  /** 更新运行状态（并进快照），返回合并后的快照 */
  async updateWorkflowState(input: {
    workflowName: string
    runId: string
    opts: UpdateWorkflowStateOptions
  }): Promise<WorkflowRunState | undefined> {
    const snapshot = (await this.loadWorkflowSnapshot(input)) ?? ({} as WorkflowRunState)
    const next = {
      ...snapshot,
      ...(input.opts as unknown as Record<string, unknown>),
    } as WorkflowRunState
    await this.saveSnapshot(input.workflowName, input.runId, next)
    return next
  }

  /** 直接改快照列（update* 复用） */
  private async saveSnapshot(
    workflowName: string,
    runId: string,
    snapshot: WorkflowRunState,
  ): Promise<void> {
    await this.persistWorkflowSnapshot({ workflowName, runId, snapshot })
  }

  private toWorkflowRun(row: RunEntity): WorkflowRun {
    return {
      workflowName: row.agentKey,
      runId: row.engineRunId ?? row.id,
      snapshot: (row.snapshot ?? {}) as unknown as WorkflowRunState,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }
  }
}

/**
 * Mastra 存储门面：**只挂 workflows 域**（记忆不做），且 `disableInit` ——
 * 表由我们自己的迁移建，绝不让 Mastra 去建它那一整套 `mastra_*` 表。
 */
export class AgentMastraStore extends MastraCompositeStore {
  constructor(db: Db, logger: AppLogger) {
    super({
      id: 'billy-agent-store',
      name: 'BillyAgentStore',
      domains: { workflows: new AgentWorkflowsStorage(db, logger) },
      disableInit: true,
    } as never)
  }
}
