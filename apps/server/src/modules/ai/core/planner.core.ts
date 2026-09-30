import { Inject, Injectable } from '@nestjs/common'
import { createTool } from '@mastra/core/tools'
import type { RequestContext } from '@mastra/core/request-context'
import { z } from 'zod'
import { TimelineRepository } from '../runtime/timeline.repository.js'
import {
  PLAN_TASK_STATUSES,
  type Plan,
  type PlanTask,
  type PlanTaskStatus,
} from '../runtime/plan.js'
import { TOOL_KEYS } from '../tools/tool-keys.js'
import type { AgentTool, AgentToolInstance } from '../tools/tools.types.js'
import { readAgentRuntime, type AgentCore } from './ai.core.types.js'

/**
 * `todo-write` 的入参契约（**给模型看的契约**）。
 *
 * 只有一个字段是必需的：`tasks` —— **完整清单**。加任务 / 删任务 / 改状态 / 重规划
 * 全部由"把当前清单整个写一遍"表达：上一版里有、这一版里没有的项即视为删除。
 *
 * `status` / `id` 做了宽容处理（省略时分别是 `pending` 与自动生成 `task-<n>`）：
 * 模型漏写不该换来一次工具报错（那会白烧一步），但默认值必须写清楚，否则它无从知道。
 */
const TodoWriteInputSchema = z.object({
  goal: z
    .string()
    .min(1)
    .max(500)
    .optional()
    .describe('这批任务要做成什么（一句话目标）。首次提交必须给；之后目标不变时可以省略（省略即沿用当前目标）'),
  tasks: z
    .array(
      z.object({
        id: z
          .string()
          .min(1)
          .max(32)
          .optional()
          .describe(
            '任务标识（如 t1）。不传则由工具生成 `task-<n>`；**同一批任务的 id 要稳定**——' +
              '状态变更靠 id 对应，换 id 等于把旧任务删掉再建一个新的',
          ),
        title: z.string().min(1).max(200).describe('这一项要做什么（动词开头，可执行、可验证）'),
        status: z
          .enum(PLAN_TASK_STATUSES)
          .optional()
          .describe('pending 未开始 / in_progress 进行中（同时只允许一个）/ completed 已完成；省略视为 pending'),
        note: z
          .string()
          .max(1000)
          .optional()
          .describe('备注：阻塞原因、取数口径、依赖等都写在这里（阻塞不单独占一个状态）'),
      }),
    )
    .min(1)
    .max(30)
    .describe('**完整任务清单**（全量提交：上一版里有而这里没有的项 = 删除）'),
})

/** `todo-write` 的出参 = 提交后的**完整清单** + 一句摘要（+ 纪律提示） */
export interface TodoWriteOutput extends Plan {
  /** 一句话摘要，如「共 5 项，已完成 2 项，当前进行中：t3；本次变更：新增 t4」 */
  summary: string
  /** 纪律提示（如同时出现多个 in_progress）。**不阻断提交**，只提醒模型下一版改回来 */
  warnings?: string[]
}

/** Mastra 工具执行上下文的最小面（只取运行时信封所在的那一项，别把它的泛型铺满本文件） */
interface ToolContextLike {
  requestContext?: RequestContext
}

/** 本轮内存里最多保留多少份计划（同一轮内的活计划，按 runId 隔离；超出按插入顺序淘汰） */
const LIVE_PLAN_MAX = 200

/**
 * **规划能力**（core bean）：提供 `todo-write` —— agent 用它维护一份**完整任务清单**。
 *
 * 与旧实现的根本差别：旧版是一个"全量覆盖 goal + steps"的写计划工具，只能整体重写、
 * 无法表达"这一项做完了"；新版把**任务清单**本身作为可演进的对象：
 * 状态、增删、重规划都是同一份清单的不同版本，模型每推进一步就提交一次。
 *
 * 三条硬约束（实现上必须守住）：
 * 1. **工具内不写库**：工具只做校验、计算并返回完整清单；把它落成 `plan` 事件的是运行时
 *    （`runtime/plan.ts` 的 `toPlanPayload`，非流式在 `chat.service`、流式在 `stream-recorder`）；
 * 2. **「当前计划」从时间线读**：该会话最后一条 `kind='plan'` 事件（`latestPlan`）——
 *    不是运行时信封的快照（信封只在一轮开始时装配一次，同一轮内会读到过期版本）；
 * 3. **同一轮内多次调用必须能读到彼此的结果**：运行时在**整轮结束后**才把工具出参落库，
 *    所以本轮第一次读时间线之后，把计划记在本轮的内存里（key = runId），后续调用读它。
 *    runId 变了（下一轮）就重新从时间线读，因此不会跨轮串味；进程内的副本也只是加速，
 *    真相始终在时间线。
 *
 * 它是 core bean 而不是业务工具 bean 的理由：规划与任何业务模块无关，属于"运行时能力"。
 */
@Injectable()
export class PlannerCore implements AgentCore {
  /** core bean 的 key（诊断用） */
  readonly key = 'planner'

  private readonly todoWrite: AgentTool

  /** runId → 本轮演进中的清单（本轮第一次调用时从时间线读入） */
  private readonly livePlans = new Map<string, Plan>()
  /** runId → 串行队列尾（同一轮内并发的工具调用不会互相覆盖，故不丢更新） */
  private readonly queues = new Map<string, Promise<unknown>>()

  constructor(@Inject(TimelineRepository) private readonly timelines: TimelineRepository) {
    const key = TOOL_KEYS.todoWrite
    const description =
      '提交当前的**完整任务清单**（全量覆盖，不是增量）：加任务 / 删任务 / 改状态 / 重规划' +
      '都靠"把当前清单整个写一遍"表达（上一版有、这一版没有的项即视为删除）。' +
      '需要多步完成的任务先写一次清单再动手；每开始一项把它标成 in_progress（同时只允许一个），' +
      '做完立刻标成 completed 并再次提交完整清单；只做一步的事不要写清单。'
    this.todoWrite = {
      key,
      title: '提交任务清单',
      description,
      tool: createTool({
        // 我们的工具 key 映射到 Mastra 的 createTool.id（它的接口字段名，值相同）
        id: key,
        description,
        inputSchema: TodoWriteInputSchema,
        execute: (input, context) =>
          this.submit(context as ToolContextLike | undefined, input),
      }) as AgentToolInstance,
    }
  }

  asTools(): readonly AgentTool[] {
    return [this.todoWrite]
  }

  /**
   * 提交一份完整清单。
   *
   * 顺序：运行时信封 → 同一轮串行队列 → 读当前计划 → 校验并生成新版本 → 更新本轮内存。
   * 任何一步失败都**不改动本轮内存**（下一轮仍从时间线读到干净的状态）。
   */
  private async submit(
    context: ToolContextLike | undefined,
    input: z.infer<typeof TodoWriteInputSchema>,
  ): Promise<TodoWriteOutput> {
    const envelope = readAgentRuntime(context?.requestContext)
    if (!envelope) {
      // 两种情形会走到这里：① 调用没走编排层（真的配错了）；② **子 agent 那一轮**
      // （`AgentRunner` 造临时 Agent 时不透传 requestContext）—— 后者是常态，
      // 所以口令是"交回主 agent"而不是"联系维护者"：清单归属发起这一轮的主 agent。
      throw new Error(
        'todo-write 缺少运行时上下文（编排层未注入 requestContext）：任务清单只在发起这一轮的主 agent 那里维护，' +
          '子助手请把结果交回主 agent，不要自己另开一份清单',
      )
    }

    const runId = envelope.parentRunId
    const conversationId = envelope.conversationId
    return this.enqueue(runId, async () => {
      const current = await this.currentPlan(runId, conversationId)
      const tasks = this.materialize(input.tasks)
      const goal = (input.goal ?? '').trim() || current?.goal || ''
      if (!goal) {
        throw new Error(
          '首次提交必须给 goal（这批任务要做成什么）；只有调整已有清单时才可以省略',
        )
      }
      const plan: Plan = { goal, revision: (current?.revision ?? 0) + 1, tasks }
      this.remember(runId, plan)
      return this.present(plan, current)
    })
  }

  /**
   * 读「当前计划」：本轮已经取过就用本轮内存里的，否则读**会话时间线**的最后一条 `plan` 事件。
   *
   * 为什么内存这一层不可省：运行时是在整轮结束后才把工具出参落成 `plan` 事件的，
   * 同一轮里的第二次调用在时间线上看不到第一次的结果 —— 没有这层，
   * "连续两次调整清单"会算出同一个 revision，模型也会拿到过期的旧清单。
   */
  private async currentPlan(runId: string, conversationId: string): Promise<Plan | null> {
    const live = this.livePlans.get(runId)
    if (live) return live
    const plan = await this.timelines.latestPlan(conversationId)
    if (plan) this.remember(runId, plan)
    return plan
  }

  /** 记住本轮的当前计划（按 runId 隔离；run 结束后的残留条目按插入顺序淘汰，不无界增长） */
  private remember(runId: string, plan: Plan): void {
    this.livePlans.delete(runId)
    this.livePlans.set(runId, plan)
    if (this.livePlans.size > LIVE_PLAN_MAX) {
      const oldest = this.livePlans.keys().next().value
      if (oldest !== undefined && oldest !== runId) this.livePlans.delete(oldest)
    }
  }

  /**
   * 同一 run 内串行执行（promise 链）：Mastra 会把同一步里的多个工具调用并发跑起来，
   * 而"读当前计划 → 生成新版本 → 写回内存"是读改写，并发就会丢更新。
   * 队列尾跑完即摘除，进程里不会按 run 堆积。
   */
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

  /** 入参清单 → 落库清单：补 id（未给的生成 `task-<n>`）、查重、补默认状态 */
  private materialize(
    raw: ReadonlyArray<{
      id?: string
      title: string
      status?: PlanTaskStatus
      note?: string
    }>,
  ): PlanTask[] {
    const used = new Set<string>()
    const tasks: PlanTask[] = []
    for (const item of raw) {
      const id = item.id?.trim() ? item.id.trim() : this.autoId(used)
      if (used.has(id)) {
        // 同 id 两条任务会让"改状态"变成掷骰子，直接拒绝（宁可让模型改一版）
        throw new Error(`任务 id 重复：${id}（同一份清单里 id 必须唯一，否则状态对应不上）`)
      }
      used.add(id)
      tasks.push({
        id,
        title: item.title,
        status: item.status ?? 'pending',
        ...(item.note?.trim() ? { note: item.note } : {}),
      })
    }
    return tasks
  }

  /** 自动 id：`task-<n>`，取第一个没被占用的序号（确定性，便于断言与排查） */
  private autoId(used: Set<string>): string {
    let n = 1
    while (used.has(`task-${n}`)) n += 1
    return `task-${n}`
  }

  /** 出参：完整清单 + 一句摘要（进度 + 相对上一版的变更），多 in_progress 时附纪律提示 */
  private present(plan: Plan, previous: Plan | null): TodoWriteOutput {
    const done = plan.tasks.filter((task) => task.status === 'completed').length
    const running = plan.tasks.filter((task) => task.status === 'in_progress')
    const summary = [
      `共 ${plan.tasks.length} 项`,
      `已完成 ${done} 项`,
      `当前进行中：${running.length > 0 ? running.map((task) => task.id).join('、') : '无'}`,
      this.describeChange(previous, plan),
    ].join('，')

    const output: TodoWriteOutput = { ...plan, summary }
    if (running.length > 1) {
      output.warnings = [
        `清单里有 ${running.length} 个 in_progress（${running
          .map((task) => task.id)
          .join('、')}）：同时只应有一个进行中，请把其余的改回 pending 或标成 completed`,
      ]
    }
    return output
  }

  /** 与上一版比对，生成一句变更摘要（模型据此确认"我这次改的生效了"） */
  private describeChange(previous: Plan | null, next: Plan): string {
    if (!previous) return '首次提交'
    const before = new Map(previous.tasks.map((task) => [task.id, task]))
    const after = new Set(next.tasks.map((task) => task.id))
    const changes: string[] = []
    if (previous.goal !== next.goal) changes.push('目标已更新')
    for (const task of next.tasks) {
      const old = before.get(task.id)
      if (!old) changes.push(`新增 ${task.id}`)
      else if (old.status !== task.status) changes.push(`${task.id} ${old.status}→${task.status}`)
      else if (old.title !== task.title) changes.push(`${task.id} 标题已更新`)
    }
    for (const task of previous.tasks) {
      if (!after.has(task.id)) changes.push(`删除 ${task.id}`)
    }
    return changes.length > 0 ? `本次变更：${changes.join('；')}` : '本次变更：清单无变化'
  }
}
