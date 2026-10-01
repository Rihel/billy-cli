import { Inject, Injectable } from '@nestjs/common'
import dedent from 'dedent'
import { z } from 'zod'
import { ToolDecl, ToolGroup } from '../../../tools/tool.decorator.js'
import { TOOL_KEYS } from '../../../tools/tool-keys.js'
import { ToolDeniedError } from '../../../tools/tools.types.js'
import type { ToolCallContext } from '../../../tools/tools.types.js'
import type { PlanTask, PlanTaskStatus } from './plan.protocol.js'
import {
  MAX_PLAN_TASKS,
  PlanCompleteInputSchema,
  PlanCreateInputSchema,
  PlanDeleteInputSchema,
  PlanReorderInputSchema,
  PlannerConfigSchema,
  type PlanOutput,
} from './planner.schemas.js'
import { materializeTasks, PlannerStore } from './planner.store.js'

/**
 * **规划工具组**：一个组一个类，**组内一个方法一个工具**（设计 §5.2 / §3.16）。
 *
 * | 方法 | 工具 key | 做什么 |
 * | --- | --- | --- |
 * | `create` | `plan-create` | 创建任务清单（一次性建多个；已有清单时是追加） |
 * | `reorder` | `plan-reorder` | 重排任务清单（改顺序 + 就地改标题 / 备注 / 状态） |
 * | `complete` | `plan-complete` | 完成任务（支持多个，幂等） |
 * | `delete` | `plan-delete` | 删除任务（支持多个，可删空） |
 *
 * 四个工具共享同一份依赖（`PlannerStore`：读清单 / 同轮串行 / 失败不改内存）与同一组
 * 组级默认值（`category: core` + `child: 'deny'`：清单归属发起这一轮的主 agent，
 * 子助手把结论交回父即可 —— 这也堵住"子 agent 的清单顶掉父的当前计划"）。
 *
 * 三条共同口径（协议层见 `plan.protocol.ts`）：
 * 1. **出参永远是完整清单快照** → 「当前计划」= 最后一条 `plan` 事件（协议只有一种形状）；
 * 2. **工具不写库**：只做校验与计算，落 `plan` 事件的是运行时（`toPlanPayload`）；
 * 3. **失败不改内存**：校验不过抛 `ToolDeniedError`，由网关翻成可纠正的结论。
 */
@Injectable()
@ToolGroup({ category: 'core', scope: 'all', child: 'deny' })
export class PlannerTools {
  constructor(@Inject(PlannerStore) private readonly store: PlannerStore) {}

  /** ① 创建任务清单（一次性建多个；已有清单时是追加） */
  @ToolDecl({
    key: TOOL_KEYS.planCreate,
    title: '创建任务清单',
    params: PlanCreateInputSchema,
    config: PlannerConfigSchema,
    description: dedent`
      创建任务清单：**一次把多个任务写进去**。

      什么时候用：需要**多步**完成的任务，**先**把清单建出来再动手；深入之后发现还缺任务，
      再用它补几条（已有清单时是**追加**，不会把已有任务冲掉）。

      什么时候不用：一步就能答完的事、寒暄与闲聊（别为单问单答套流程）；
      调整已有任务请用 \`plan-reorder\`，完成用 \`plan-complete\`，删除用 \`plan-delete\`。

      纪律：
      - **第一次创建必须给 \`goal\`**（这批任务要做成什么），之后可以省略（沿用当前目标）；
      - 给任务传 \`id\`（如 t1）并**保持不变**：后续完成 / 删除 / 重排都靠它对应；
        不传则由工具生成 \`task-<n>\`（那你就得从返回值里记住它）；
      - 任务是可执行、可验证的动作（动词开头），别写成"研究一下"这种无法收口的；
      - 阻塞、口径、依赖写进 \`note\` —— **不要新开一个任务表达"被卡住了"**。
    `,
  })
  async create(
    input: z.infer<typeof PlanCreateInputSchema>,
    ctx: ToolCallContext,
  ): Promise<PlanOutput> {
    return this.store.mutate(ctx, (current) => {
      const goal = (input.goal ?? current?.goal ?? '').trim()
      if (!goal) {
        throw new ToolDeniedError(
          'invalid-input',
          '第一次创建清单必须给 goal（这批任务要做成什么）',
        )
      }
      const existing = current?.tasks ?? []
      const created = materializeTasks(input.tasks, existing)
      if (existing.length + created.length > MAX_PLAN_TASKS) {
        throw new ToolDeniedError(
          'invalid-input',
          `清单最多 ${MAX_PLAN_TASKS} 项（现在是 ${existing.length} 项，这次要加 ${created.length} 项）—— 请合并或删掉一些再试`,
        )
      }
      return {
        plan: { goal, tasks: [...existing, ...created] },
        changes: created.map((task) => `新增 ${task.id}`),
      }
    })
  }

  /** ② 重排任务清单（`order` 全量排列 + `updates` 就地修改） */
  @ToolDecl({
    key: TOOL_KEYS.planReorder,
    title: '重排任务清单',
    params: PlanReorderInputSchema,
    config: PlannerConfigSchema,
    description: dedent`
      重排任务清单：**改顺序**，以及**就地修改**已有任务（标题 / 备注 / 状态）。

      什么时候用：
      - 发现原来的顺序不对（先做依赖项、先出结论、先验证前提）→ 给 \`order\`；
      - 任务要改口径 / 补备注 / **开始做某一项** → 给 \`updates\`（把该项标 \`in_progress\`）。

      纪律：
      - \`order\` 必须是**全部任务 id 的新顺序**（一一对应）：少了、多了都会报错并把差异列给你；
      - 一个任务的内容变了用 \`updates\` 改它，**不要用"删掉再新建"表达**（那样历史与 id 就断了）；
      - 状态三态：\`pending\` / \`in_progress\`（**同时只允许一个**）/ \`completed\`；
        完成多项请用 \`plan-complete\`（它会一次标完并给结论）。
    `,
  })
  async reorder(
    input: z.infer<typeof PlanReorderInputSchema>,
    ctx: ToolCallContext,
  ): Promise<PlanOutput> {
    return this.store.mutate(ctx, (current) => {
      if (!current || current.tasks.length === 0) {
        throw new ToolDeniedError(
          'precheck-failed',
          '现在还没有任务清单：请先用 plan-create 建一份再重排',
          '先创建任务清单',
        )
      }
      const changes: string[] = []
      const byId = new Map(current.tasks.map((task) => [task.id, task]))

      // ① 就地修改（先改内容，再按 order 重排）
      const updated = new Map<string, PlanTask>()
      for (const change of input.updates ?? []) {
        const task = byId.get(change.id)
        if (!task) {
          throw new ToolDeniedError(
            'invalid-input',
            `任务不存在：${change.id}（当前清单：${current.tasks.map((item) => item.id).join('、')}）`,
          )
        }
        const next: PlanTask = {
          ...task,
          ...(change.title !== undefined ? { title: change.title } : {}),
          ...(change.status !== undefined ? { status: change.status } : {}),
        }
        if (change.note !== undefined) {
          if (change.note.trim()) next.note = change.note
          else delete next.note
        }
        updated.set(next.id, next)
        if (change.status !== undefined && change.status !== task.status) {
          changes.push(`${task.id} ${task.status}→${change.status}`)
        } else if (change.title !== undefined && change.title !== task.title) {
          changes.push(`${task.id} 标题已更新`)
        } else if (change.note !== undefined) {
          changes.push(`${task.id} 备注已更新`)
        }
      }
      const merged = current.tasks.map((task) => updated.get(task.id) ?? task)

      // ② 重排：order 必须是当前全部 id 的一个排列
      if (input.order) {
        const expected = new Set(merged.map((task) => task.id))
        const given = input.order
        const missing = [...expected].filter((id) => !given.includes(id))
        const unknown = given.filter((id) => !expected.has(id))
        const duplicated = given.length !== new Set(given).size
        if (
          missing.length > 0 ||
          unknown.length > 0 ||
          duplicated ||
          given.length !== expected.size
        ) {
          throw new ToolDeniedError(
            'invalid-input',
            `order 必须与当前清单一一对应：${missing.length > 0 ? `少了 ${missing.join('、')}；` : ''}${
              unknown.length > 0 ? `多了 ${unknown.join('、')}；` : ''
            }${duplicated ? '有重复 id；' : ''}当前清单：${[...expected].join('、')}`,
          )
        }
        const orderIndex = new Map(given.map((id, index) => [id, index]))
        merged.sort(
          (left, right) => (orderIndex.get(left.id) ?? 0) - (orderIndex.get(right.id) ?? 0),
        )
        changes.unshift('顺序已重排')
      }
      return { plan: { goal: current.goal, tasks: merged }, changes }
    })
  }

  /** ③ 完成任务（支持一次完成多个） */
  @ToolDecl({
    key: TOOL_KEYS.planComplete,
    title: '完成任务',
    params: PlanCompleteInputSchema,
    config: PlannerConfigSchema,
    description: dedent`
      完成任务：把**一个或多个**已经做完的任务标成 \`completed\`。

      什么时候用：做完一项（或一批）**立刻**标，不要攒到最后一起标 —— 清单要始终反映真实进度。

      纪律：
      - \`ids\` 给的是**已经做完**的任务；没做完的别标（宁可继续做或标成 pending）；
      - 已经在 \`completed\` 的再标一次不算错（幂等），但没必要；
      - 可给 \`note\` 写完成口径 / 结论（会写进这些任务的备注）；
      - 标完之后用自己的话把结论交付给用户 —— **不要把清单内容当成回答**。
    `,
  })
  async complete(
    input: z.infer<typeof PlanCompleteInputSchema>,
    ctx: ToolCallContext,
  ): Promise<PlanOutput> {
    return this.store.mutate(ctx, (current) => {
      if (!current || current.tasks.length === 0) {
        throw new ToolDeniedError(
          'precheck-failed',
          '现在还没有任务清单：请先用 plan-create 建一份',
        )
      }
      const byId = new Map(current.tasks.map((task) => [task.id, task]))
      const unknown = input.ids.filter((id) => !byId.has(id))
      if (unknown.length > 0) {
        throw new ToolDeniedError(
          'invalid-input',
          `任务不存在：${unknown.join('、')}（当前清单：${current.tasks
            .map((item) => item.id)
            .join('、')}）`,
        )
      }
      const targets = new Set(input.ids)
      const changes: string[] = []
      const tasks = current.tasks.map((task) => {
        if (!targets.has(task.id)) return task
        if (task.status === 'completed') return task
        changes.push(`${task.id} ${task.status}→completed`)
        return {
          ...task,
          status: 'completed' as PlanTaskStatus,
          ...(input.note?.trim() ? { note: input.note } : {}),
        }
      })
      if (changes.length === 0) changes.push('这些任务本来就是已完成的（无变化）')
      return { plan: { goal: current.goal, tasks }, changes }
    })
  }

  /** ④ 删除任务（支持一次删除多个） */
  @ToolDecl({
    key: TOOL_KEYS.planDelete,
    title: '删除任务',
    params: PlanDeleteInputSchema,
    config: PlannerConfigSchema,
    description: dedent`
      删除任务：把**一个或多个**任务从清单里去掉。

      什么时候用：某项**确认不做了**、或与其他项重复时。

      什么时候不用：只是"这一版不做"—— 那种情况把状态留在 \`pending\` 更诚实（否则复盘时看不出它曾经被规划过）。

      纪律：
      - 一次可以给多个 \`ids\`；不存在的 id 会报错并把当前清单列出来；
      - 删到空清单是允许的（目标保留），之后可以用 \`plan-create\` 重新建任务；
      - 删之前想清楚：**这条被删掉的记录不会留在清单里**（它当初被建过这件事仍然在时间线上，可复盘）。
    `,
  })
  async delete(
    input: z.infer<typeof PlanDeleteInputSchema>,
    ctx: ToolCallContext,
  ): Promise<PlanOutput> {
    return this.store.mutate(ctx, (current) => {
      if (!current || current.tasks.length === 0) {
        throw new ToolDeniedError(
          'precheck-failed',
          '现在还没有任务清单：请先用 plan-create 建一份',
        )
      }
      const targets = new Set(input.ids)
      const unknown = input.ids.filter((id) => !current.tasks.some((task) => task.id === id))
      if (unknown.length > 0) {
        throw new ToolDeniedError(
          'invalid-input',
          `任务不存在：${unknown.join('、')}（当前清单：${current.tasks
            .map((item) => item.id)
            .join('、')}）`,
        )
      }
      return {
        plan: { goal: current.goal, tasks: current.tasks.filter((task) => !targets.has(task.id)) },
        changes: [...targets].map((id) => `删除 ${id}`),
      }
    })
  }
}
