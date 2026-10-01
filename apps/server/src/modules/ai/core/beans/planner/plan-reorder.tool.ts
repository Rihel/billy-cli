import { Inject, Injectable } from '@nestjs/common'
import dedent from 'dedent'
import { z } from 'zod'
import type { PlanTask } from './plan.protocol.js'
import { ToolDecl, ToolExec } from '../../../tools/tool.decorator.js'
import { TOOL_KEYS } from '../../../tools/tool-keys.js'
import { ToolDeniedError } from '../../../tools/tools.types.js'
import type { ToolCallContext } from '../../../tools/tools.types.js'
import {
  PlanReorderInputSchema,
  PlannerConfigSchema,
  type PlanOutput,
} from './planner.schemas.js'
import { PlannerStore } from './planner.store.js'

/**
 * `plan-reorder`：**重排任务清单**（顺序 + 就地修改）。
 *
 * 两种用法：
 * - `order`：给**全部任务 id 的新顺序**（一一对应；少了 / 多了 / 重复都报错并列出差异）；
 * - `updates`：就地改标题 / 备注 / 状态 —— **"开始做某一项"也走它**（标 `in_progress`）。
 *
 * 为什么要求 `order` 是全量排列：局部重排（"把 t3 提前"）的语义有歧义（提到第几？其余怎么让位？），
 * 而"给一份新顺序"没有歧义，也便于校验（差异直接列给模型）。
 * 为什么内容改了要 `updates` 而不是"删掉再建"：后者会让 id 与历史断掉，复盘时看不出是同一条任务。
 */
@Injectable()
@ToolDecl({
  key: TOOL_KEYS.planReorder,
  title: '重排任务清单',
  category: 'core',
  scope: 'all',
  child: 'deny',
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
export class PlanReorderTool {
  constructor(@Inject(PlannerStore) private readonly store: PlannerStore) {}

  @ToolExec()
  async execute(
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
        if (missing.length > 0 || unknown.length > 0 || duplicated || given.length !== expected.size) {
          throw new ToolDeniedError(
            'invalid-input',
            `order 必须与当前清单一一对应：${missing.length > 0 ? `少了 ${missing.join('、')}；` : ''}${
              unknown.length > 0 ? `多了 ${unknown.join('、')}；` : ''
            }${duplicated ? '有重复 id；' : ''}当前清单：${[...expected].join('、')}`,
          )
        }
        const orderIndex = new Map(given.map((id, index) => [id, index]))
        merged.sort((left, right) => (orderIndex.get(left.id) ?? 0) - (orderIndex.get(right.id) ?? 0))
        changes.unshift('顺序已重排')
      }
      return { plan: { goal: current.goal, tasks: merged }, changes }
    })
  }
}
