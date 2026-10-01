import { Inject, Injectable } from '@nestjs/common'
import dedent from 'dedent'
import { z } from 'zod'
import type { PlanTaskStatus } from './plan.protocol.js'
import { ToolDecl, ToolExec } from '../../../tools/tool.decorator.js'
import { TOOL_KEYS } from '../../../tools/tool-keys.js'
import { ToolDeniedError } from '../../../tools/tools.types.js'
import type { ToolCallContext } from '../../../tools/tools.types.js'
import {
  PlanCompleteInputSchema,
  PlannerConfigSchema,
  type PlanOutput,
} from './planner.schemas.js'
import { PlannerStore } from './planner.store.js'

/**
 * `plan-complete`：**完成任务**（支持一次完成多个）。
 *
 * 幂等：已经在 `completed` 的再标一次不算错（出参摘要里说明"无变化"）——
 * 模型重试同一次调用不该换来一句报错。可选的 `note` 写完成口径 / 结论。
 */
@Injectable()
@ToolDecl({
  key: TOOL_KEYS.planComplete,
  title: '完成任务',
  category: 'core',
  scope: 'all',
  child: 'deny',
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
export class PlanCompleteTool {
  constructor(@Inject(PlannerStore) private readonly store: PlannerStore) {}

  @ToolExec()
  async execute(
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
}
