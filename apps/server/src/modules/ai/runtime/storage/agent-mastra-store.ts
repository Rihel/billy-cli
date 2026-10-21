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
 * 快照存 `runs.snapshot`（JSONB）；一轮 durable agent 会同时产生外层 loop 与内层
 * execution 两个 workflow 快照，所以值是 `{ [workflowName]: snapshot }`，按名读取。
 * 运行状态仍由我们自己的运行服务维护 —— 于是"崩溃恢复"需要的快照与"业务真相"在同一行上，
 * 不会两处打架。
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
    case 'suspended':
      return RunStatus.Suspended
    case 'pending':
    case 'waiting':
    case 'paused':
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
    case RunStatus.Suspended:
      return 'suspended'
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

/**
 * 一轮 durable agent 会同时产生**多个 workflow 的快照**：外层 `durable-agentic-loop`
 * 与内层 `durable-agentic-execution`。它们共用一个 engine runId，
 * 所以不能只存"最后一个快照"—— 否则外层会覆盖内层，resume 时内层 step 的 input 就没了
 * （实测报 `Cannot destructure property 'agentId' of 'typedInput'`）。
 *
 * `runs.snapshot` 因此存成 `{ [workflowName]: WorkflowRunState }`。旧数据是单个快照对象，
 * 读取时按 legacy 兼容。
 */
type SnapshotMap = Record<string, WorkflowRunState>

const isWorkflowSnapshot = (value: unknown): value is WorkflowRunState =>
  Boolean(value) &&
  typeof value === 'object' &&
  ('context' in (value as object) || 'status' in (value as object)) &&
  'runId' in (value as object)

const snapshotMapOf = (value: unknown): SnapshotMap => {
  if (!value || typeof value !== 'object') return {}
  if (isWorkflowSnapshot(value)) {
    // 旧格式：单快照。外层 workflow 名是 Mastra 的固定 id，用它兜底。
    return { 'durable-agentic-loop': value }
  }
  return value as SnapshotMap
}

const pickSnapshot = (map: SnapshotMap, workflowName?: string): WorkflowRunState | undefined => {
  if (workflowName) return map[workflowName]
  return Object.values(map)[0]
}

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
    const existing = await repo.findOne({ where: { engineRunId: input.runId } })
    const map = snapshotMapOf(existing?.snapshot)
    map[input.workflowName] = input.snapshot
    const affected = await repo
      .createQueryBuilder()
      .update(RunEntity)
      .set(
        jsonbPatch<RunEntity>({
          snapshot: map as unknown as Record<string, unknown>,
          ...(status ? { status } : {}),
        }),
      )
      .where('engine_run_id = :runId', { runId: input.runId })
      .execute()

    if ((affected.affected ?? 0) > 0) return

    /**
     * 没有对应的运行记录 → **只记日志，绝不插一行**（踩过的坑）。
     *
     * 早先这里"落一条最小记录"，用 `conversationId: ''` 造了个**影子 run**，结果第二次持久化就撞
     * `uk_run_active_conversation`（该部分唯一索引约束的是"同一会话只允许一轮进行中的**根 run**"，
     * 而影子行 `parent_run_id IS NULL` + `status='running'`，两张影子行同属"会话 `''`"）——
     * 启动 durable agent 时直接抛 QueryFailedError。
     *
     * 更根本的是：`runs` 是**审计记录**，一行必须对应一次真实的用户问答；适配层凭空造行，
     * 会让"这一轮是谁问的、问了什么"永远查不到。快照找不到宿主，说明编排层没把 engine runId
     * 回写（已在 `chat.service` 修：`attachEngineRun`），这时**丢的是快照、不是账**，如实记日志即可。
     */
    this.appLogger.warn('ai.storage.snapshot_orphan_skipped', {
      workflowName: input.workflowName,
      runId: input.runId,
      reason: '没有对应的 runs 行（engine_run_id 未回写？）—— 跳过快照，绝不造影子记录',
    })
  }

  /** 读快照（恢复时用它重建现场） */
  async loadWorkflowSnapshot(input: {
    workflowName: string
    runId: string
  }): Promise<WorkflowRunState | null> {
    const repo = await this.db.getRepository(RunEntity)
    const row = await repo.findOne({ where: { engineRunId: input.runId } })
    if (!row?.snapshot) return null
    return pickSnapshot(snapshotMapOf(row.snapshot), input.workflowName) ?? null
  }

  /** 列出运行（恢复流程据此找"在跑的"） */
  async listWorkflowRuns(args: StorageListWorkflowRunsInput = {}): Promise<WorkflowRuns> {
    const repo = await this.db.getRepository(RunEntity)
    const builder = repo
      .createQueryBuilder('r')
      .where('r.engineRunId IS NOT NULL')
      .orderBy('r.createdAt', 'DESC')

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
    const runs = rows
      .map((row) => this.toWorkflowRun(row, args.workflowName))
      .filter((run): run is WorkflowRun => Boolean(run))
    return { runs, total }
  }

  async getWorkflowRunById(input: {
    runId: string
    workflowName?: string
  }): Promise<WorkflowRun | null> {
    const repo = await this.db.getRepository(RunEntity)
    const row = await repo.findOne({ where: { engineRunId: input.runId } })
    return row ? this.toWorkflowRun(row, input.workflowName) : null
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

  private toWorkflowRun(row: RunEntity, workflowName?: string): WorkflowRun | null {
    const map = snapshotMapOf(row.snapshot)
    if (workflowName && !map[workflowName]) return null
    const name = workflowName && map[workflowName] ? workflowName : Object.keys(map)[0]
    if (!name) return null
    const snapshot = map[name]
    if (!snapshot) return null
    return {
      workflowName: name,
      runId: row.engineRunId ?? row.id,
      snapshot,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }
  }
}

/**
 * Mastra 存储统一入口：**只挂 workflows 域**（记忆不做），且 `disableInit` ——
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
