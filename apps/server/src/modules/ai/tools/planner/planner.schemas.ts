import { z } from 'zod'
import { PLAN_TASK_STATUSES, type Plan } from '../../runtime/plan.protocol.js'

/**
 * 规划工具集的**入参定义**（给模型看的数据结构）与出参类型。
 *
 * 数据结构就是"DSL 的参数部分"：四个工具各自的字段都写在这里，工具实现文件只写业务动作。
 * 共享的任务形状（`TaskInputSchema`）抽出来，避免四个文件各写一遍再漂移。
 */

/** 一个任务项（四个工具共用；`id` 不给则由工具生成 `task-<n>`） */
export const TaskInputSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(32)
    .optional()
    .describe(
      `任务标识（如 t1）。不传则由工具生成 \`task-<n>\`；**同一批任务的 id 要稳定**——后续的完成 / 删除 / 重排都靠 id 对应`,
    ),
  title: z.string().min(1).max(200).describe('这一项要做什么（动词开头，可执行、可验证）'),
  status: z
    .enum(PLAN_TASK_STATUSES)
    .optional()
    .describe(
      'pending 未开始 / in_progress 进行中（同时只允许一个）/ completed 已完成；省略视为 pending',
    ),
  note: z
    .string()
    .max(1000)
    .optional()
    .describe('备注：阻塞原因、取数口径、依赖等都写在这里（阻塞不单独占一个状态）'),
})

export type TaskInput = z.infer<typeof TaskInputSchema>

/** `plan-create`：创建任务清单（一次性建多个；已有清单时是追加） */
export const PlanCreateInputSchema = z.object({
  goal: z
    .string()
    .min(1)
    .max(500)
    .optional()
    .describe(
      '这批任务要做成什么（一句话目标）。**第一次创建清单必须给**；已有清单时可以省略（沿用当前目标）',
    ),
  tasks: z.array(TaskInputSchema).min(1).max(30).describe('要创建的任务（一次可以建多个）'),
})

/** `plan-reorder`：重排任务清单（顺序 + 就地修改，二者至少给一个） */
export const PlanReorderInputSchema = z
  .object({
    order: z
      .array(z.string().min(1).max(32))
      .min(1)
      .optional()
      .describe('**全部任务 id 的新顺序**（必须与当前清单一一对应：少了、多了都会报错并列出差异）'),
    updates: z
      .array(
        z.object({
          id: z.string().min(1).max(32).describe('要改的任务 id'),
          title: z.string().min(1).max(200).optional().describe('新标题（不改就省略）'),
          note: z.string().max(1000).optional().describe('新备注（不改就省略）'),
          status: z
            .enum(PLAN_TASK_STATUSES)
            .optional()
            .describe('新状态。**开始做某一项就用它标 in_progress**；完成请用 plan-complete'),
        }),
      )
      .min(1)
      .max(50)
      .optional()
      .describe('就地修改（标题 / 备注 / 状态）'),
  })
  .refine((value) => value.order !== undefined || value.updates !== undefined, {
    message: 'order 与 updates 至少要给一个（只重排就给 order；只改内容就给 updates）',
  })

/** `plan-complete`：完成任务（支持一次完成多个） */
export const PlanCompleteInputSchema = z.object({
  ids: z
    .array(z.string().min(1).max(32))
    .min(1)
    .max(50)
    .describe('已做完的任务 id（一次可以给多个）'),
  note: z.string().max(1000).optional().describe('完成口径 / 结论（可选，会写进这些任务的备注）'),
})

/** `plan-delete`：删除任务（支持一次删除多个） */
export const PlanDeleteInputSchema = z.object({
  ids: z
    .array(z.string().min(1).max(32))
    .min(1)
    .max(50)
    .describe('要删除的任务 id（一次可以给多个）'),
})

/** 四个规划工具的配置：目前没有可配项（开关 / 作用域 / 限额都在配置表里） */
export const PlannerConfigSchema = z.object({})

export type PlannerConfig = z.infer<typeof PlannerConfigSchema>

/** 四个工具的出参：**完整清单** + 一句摘要（+ 纪律提示） */
export interface PlanOutput extends Plan {
  /** 一句话摘要，如「共 5 项，已完成 2 项，当前进行中：t3，本次变更：t1 pending→completed」 */
  summary: string
  /** 纪律提示（如同时出现多个 in_progress）。**不阻断提交**，只提醒模型下一版改回来 */
  warnings?: string[]
}

/** 单份清单的任务总数上限（防"拆到一百项"把上下文吃光） */
export const MAX_PLAN_TASKS = 100
