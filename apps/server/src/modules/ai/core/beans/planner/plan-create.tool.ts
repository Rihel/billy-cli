import { Inject, Injectable } from '@nestjs/common'
import dedent from 'dedent'
import { z } from 'zod'
import { ToolDecl, ToolExec } from '../../../tools/tool.decorator.js'
import { TOOL_KEYS } from '../../../tools/tool-keys.js'
import { ToolDeniedError } from '../../../tools/tools.types.js'
import type { ToolCallContext } from '../../../tools/tools.types.js'
import {
  MAX_PLAN_TASKS,
  PlanCreateInputSchema,
  PlannerConfigSchema,
  type PlanOutput,
} from './planner.schemas.js'
import { materializeTasks, PlannerStore } from './planner.store.js'

/**
 * `plan-create`：**创建任务清单**（一次性建多个任务）。
 *
 * 语义：没有清单时创建（必须给 `goal`）；**已有清单时是追加**（`goal` 可省略 = 沿用当前目标）。
 * 为什么是追加而不是覆盖：规划是**逐步深入**的（先建骨架、边做边补），
 * 覆盖式写法要求模型每次重抄全清单 —— 清单长了就是 token 与漏抄错误的主要来源。
 */
@Injectable()
@ToolDecl({
  key: TOOL_KEYS.planCreate,
  title: '创建任务清单',
  category: 'core',
  scope: 'all',
  child: 'deny',
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
export class PlanCreateTool {
  constructor(@Inject(PlannerStore) private readonly store: PlannerStore) {}

  @ToolExec()
  async execute(
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
}
