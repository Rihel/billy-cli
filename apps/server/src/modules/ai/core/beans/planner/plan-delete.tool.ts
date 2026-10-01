import { Inject, Injectable } from '@nestjs/common'
import dedent from 'dedent'
import { z } from 'zod'
import { ToolDecl, ToolExec } from '../../../tools/tool.decorator.js'
import { TOOL_KEYS } from '../../../tools/tool-keys.js'
import { ToolDeniedError } from '../../../tools/tools.types.js'
import type { ToolCallContext } from '../../../tools/tools.types.js'
import {
  PlanDeleteInputSchema,
  PlannerConfigSchema,
  type PlanOutput,
} from './planner.schemas.js'
import { PlannerStore } from './planner.store.js'

/**
 * `plan-delete`：**删除任务**（支持一次删除多个）。
 *
 * 与"标成 pending"的分界（写在工具说明里，让模型自己选）：
 * 确认不做了才删；"这一版不做"应该留在 `pending` —— 否则复盘时看不出它曾经被规划过。
 * 允许删空（`goal` 保留）：清空重来是合法动作，之后可以用 `plan-create` 重新建任务。
 */
@Injectable()
@ToolDecl({
  key: TOOL_KEYS.planDelete,
  title: '删除任务',
  category: 'core',
  scope: 'all',
  child: 'deny',
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
export class PlanDeleteTool {
  constructor(@Inject(PlannerStore) private readonly store: PlannerStore) {}

  @ToolExec()
  async execute(
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
