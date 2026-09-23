import { Injectable } from '@nestjs/common'
import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { TOOL_KEYS } from '../tools/tool-keys.js'
import type { AgentTool, AgentToolInstance } from '../tools/tools.types.js'
import type { AgentCore } from './ai.core.types.js'

/**
 * 计划的入参契约（**给模型看的契约**）。
 *
 * 语义刻意做成「**全量覆盖**」（与 Mastra 内建 `task_write` 一致）：
 * 模型每次提交完整的步骤列表（含每步状态），而不是增量改一条 ——
 * 好处是**无状态**：工具不需要读历史、不需要 per-request 上下文，落库与复盘也简单。
 */
const WritePlanInputSchema = z.object({
  goal: z.string().min(1).max(500).describe('这次要做成什么（一句话目标）'),
  steps: z
    .array(
      z.object({
        id: z.string().min(1).max(32).describe('步骤标识（如 s1 / s2），后续更新状态时复用'),
        title: z.string().min(1).max(200).describe('这一步要做什么（动词开头，可执行）'),
        status: z
          .enum(['pending', 'in_progress', 'done'])
          .describe('状态：pending 未开始 / in_progress 进行中 / done 已完成'),
      }),
    )
    .min(1)
    .max(20)
    .describe('完整步骤列表（每次调用都要给全量，不是增量）'),
})

/**
 * **规划能力**（core bean）：提供 `write-plan` 工具 —— 让 agent 先把计划写下来，再逐步推进。
 *
 * 为什么自建而不是用 Mastra 内建的 task 工具：内建四件套（`task_write` 等）**强依赖
 * Mastra 的 memory + storage**（没有 memory 时它们直接 no-op 并提示"需要 agent memory"），
 * 而本工程刻意不接 Mastra memory（数据表自己设计）。自建一个无状态工具更贴合：
 * 工具只做入参校验与回显，**计划本身由运行时落成时间线的 `plan` 事件**
 * （只追加、可复盘："谁在什么时候把哪一步标成了完成"）。
 *
 * 它是 core bean 而不是业务工具 bean 的理由：规划与任何业务模块无关，
 * 属于"运行时能力"（见 `AgentCore` 的注释）。
 */
@Injectable()
export class PlannerCore implements AgentCore {
  /** core bean 的 key（诊断用） */
  readonly key = 'planner'

  private readonly writePlan: AgentTool

  constructor() {
    const key = TOOL_KEYS.writePlan
    const description =
      '为一个需要多步完成的任务写下执行计划，并在推进过程中更新每一步的状态。' +
      '接到需要多步完成的任务时**先调用本工具**写出计划，再开始执行；' +
      '每完成或开始一步时**再次调用**，提交更新后的完整计划（全量覆盖）。'
    this.writePlan = {
      key,
      title: '编写执行计划',
      description,
      tool: createTool({
        // 我们的工具 key 映射到 Mastra 的 createTool.id（它的接口字段名，值相同）
        id: key,
        description,
        inputSchema: WritePlanInputSchema,
        execute: async (input) => {
          const done = input.steps.filter((step) => step.status === 'done').length
          // 原样回显（**不裁剪**）：运行时会把这份输出落成 `plan` 事件，前端据此渲染计划卡片
          return {
            goal: input.goal,
            steps: input.steps,
            summary: `共 ${input.steps.length} 步，已完成 ${done} 步`,
          }
        },
      }) as AgentToolInstance,
    }
  }

  asTools(): readonly AgentTool[] {
    return [this.writePlan]
  }
}
