import { Inject, Injectable } from '@nestjs/common'
import { type Plan, type PlanTask } from './plan.protocol.js'
import { TimelineRepository } from '../../../runtime/timeline.repository.js'
import { ToolDeniedError } from '../../../tools/tools.types.js'
import type { ToolCallContext } from '../../../tools/tools.types.js'
import type { AgentRuntimeEnvelope } from '../../ai.core.types.js'
import type { PlanOutput, TaskInput } from './planner.schemas.js'

/** 本轮内存里最多保留多少份计划（按 runId 隔离；超出按插入顺序淘汰） */
const LIVE_PLAN_MAX = 200

/** 一次变更的结果（工具实现只描述"变成什么样"） */
export interface PlanMutation {
  plan: { goal: string; tasks: PlanTask[] }
  changes: string[]
}

/**
 * 规划工具集的**共享机制**（四个工具都走它，所以单独一个文件）。
 *
 * 三件事：
 * 1. **读当前清单**：本轮内存 → 会话时间线的最后一条 `plan` 事件（`latestPlan` 内部只看根 run）；
 * 2. **同一轮串行**（promise 链）：读改写并发会丢更新；队列尾跑完即摘除；
 * 3. **失败不改内存**：变更函数抛错时直接向上冒（网关翻成可执行结论），内存与时间线都没被动过。
 *
 * 工具实现（`plan-*.tool.ts`）只写自己的校验与"变成什么样"，不碰存储细节。
 */
@Injectable()
export class PlannerStore {
  /** runId → 本轮演进中的清单（本轮第一次调用时从时间线读入） */
  private readonly livePlans = new Map<string, Plan>()
  /** runId → 串行队列尾 */
  private readonly queues = new Map<string, Promise<unknown>>()

  constructor(@Inject(TimelineRepository) private readonly timelines: TimelineRepository) {}

  /** 一次变更的完整流程：信封 → 同轮串行 → 读当前清单 → 变更并提交 → 返回完整清单 */
  async mutate(
    ctx: ToolCallContext,
    mutate: (current: Plan | null) => PlanMutation,
  ): Promise<PlanOutput> {
    const envelope = (ctx.envelope as AgentRuntimeEnvelope | null) ?? null
    if (!envelope) {
      throw new ToolDeniedError(
        'precheck-failed',
        '任务清单缺少运行时上下文（编排层未注入信封）：清单只在发起这一轮的主 agent 那里维护',
        '把结果交回主 agent，不要自己另开一份清单',
      )
    }
    const runId = envelope.parentRunId
    const conversationId = envelope.conversationId
    return this.enqueue(runId, async () => {
      const current = await this.currentPlan(runId, conversationId)
      const result = mutate(current)
      const plan: Plan = {
        goal: result.plan.goal,
        revision: (current?.revision ?? 0) + 1,
        tasks: result.plan.tasks,
      }
      this.remember(runId, plan)
      return present(plan, current, result.changes)
    })
  }

  /** 当前清单：本轮内存优先，否则读时间线最后一条 `plan` 事件 */
  private async currentPlan(runId: string, conversationId: string): Promise<Plan | null> {
    const live = this.livePlans.get(runId)
    if (live) return live
    const plan = await this.timelines.latestPlan(conversationId)
    if (plan) this.remember(runId, plan)
    return plan
  }

  private remember(runId: string, plan: Plan): void {
    this.livePlans.delete(runId)
    this.livePlans.set(runId, plan)
    if (this.livePlans.size > LIVE_PLAN_MAX) {
      const oldest = this.livePlans.keys().next().value
      if (oldest !== undefined && oldest !== runId) this.livePlans.delete(oldest)
    }
  }

  private enqueue<T>(runId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(runId) ?? Promise.resolve()
    const run = previous.then(task, task)
    const tail = run.then(
      () => undefined,
      () => undefined,
    )
    this.queues.set(runId, tail)
    void tail.then(() => {
      if (this.queues.get(runId) === tail) this.queues.delete(runId)
    })
    return run
  }
}

/**
 * 新任务 → 落库形状：补 id（未给的生成 `task-<n>`）、查重（与本批 + 已有清单）。
 *
 * 纯函数：给四个工具共用，可单测。
 */
export const materializeTasks = (
  raw: readonly TaskInput[],
  existing: readonly PlanTask[],
): PlanTask[] => {
  const used = new Set(existing.map((task) => task.id))
  const created: PlanTask[] = []
  for (const item of raw) {
    const id = item.id?.trim() ? item.id.trim() : autoId(used)
    if (used.has(id)) {
      // 同 id 会让人分不清改的是哪一项；宁可让模型改一版
      throw new ToolDeniedError(
        'invalid-input',
        `任务 id 重复：${id}（清单里 id 必须唯一，否则完成 / 删除 / 重排都对不上）`,
      )
    }
    used.add(id)
    created.push({
      id,
      title: item.title,
      status: item.status ?? 'pending',
      ...(item.note?.trim() ? { note: item.note } : {}),
    })
  }
  return created
}

/** 自动 id：`task-<n>`，取第一个没被占用的序号（确定性，便于断言与排查） */
const autoId = (used: Set<string>): string => {
  let n = 1
  while (used.has(`task-${n}`)) n += 1
  return `task-${n}`
}

/** 出参：完整清单 + 一句摘要（进度 + 本次变更），多 `in_progress` 时附纪律提示 */
const present = (plan: Plan, previous: Plan | null, changes: string[]): PlanOutput => {
  const done = plan.tasks.filter((task) => task.status === 'completed').length
  const running = plan.tasks.filter((task) => task.status === 'in_progress')
  const summary = [
    `共 ${plan.tasks.length} 项`,
    `已完成 ${done} 项`,
    `当前进行中：${running.length > 0 ? running.map((task) => task.id).join('、') : '无'}`,
    `本次变更：${changes.length > 0 ? changes.join('；') : previous ? '清单无变化' : '首次创建'}`,
  ].join('，')

  const output: PlanOutput = { ...plan, summary }
  if (running.length > 1) {
    output.warnings = [
      `清单里有 ${running.length} 个 in_progress（${running
        .map((task) => task.id)
        .join('、')}）：同时只应有一个进行中，请用 plan-reorder 把其余的改回 pending 或标成 completed`,
    ]
  }
  return output
}
