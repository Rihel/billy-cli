import { TOOL_KEYS } from '../tools/tool-keys.js'

/**
 * **任务清单协议**（规划能力的唯一事实源）。
 *
 * 语义刻意做成「**全量提交**」（与 DSH / 工程内 agent 运行时的 `todo_write` 一致）：
 * agent 每次提交**完整清单**，加任务 / 删任务 / 改状态 / 重规划**全部由全量清单表达**
 * ——上一版里有、这一版里没有的项即视为删除。
 *
 * 为什么这样比"增删改一组工具"可靠：模型只需要维护一份"当前应该是什么样"的视图，
 * 不需要记"上一条命令改了什么"，少一类状态机就少一类漂移（漏删、改错项、id 对不上）。
 * 代价是每次都要回传整个清单 —— 工具出参本来也是全量，这个代价换来的是可预测。
 *
 * 落库方式：运行时把工具出参里的清单落成时间线的 `plan` 事件（**只追加**），
 * 「当前计划」= 该会话最后一条 `plan` 事件。
 */

/** 任务状态（协议固定三态；阻塞写在 `note` 里，不单独占一个状态） */
export const PLAN_TASK_STATUSES = ['pending', 'in_progress', 'completed'] as const

export type PlanTaskStatus = (typeof PLAN_TASK_STATUSES)[number]

/** 清单里的一项 */
export interface PlanTask {
  /** 任务标识（模型给，如 t1；不给时由工具生成 `task-<n>`）—— 同一批任务里必须唯一且稳定 */
  id: string
  /** 要做什么（动词开头，可执行、可验证） */
  title: string
  status: PlanTaskStatus
  /** 备注（阻塞原因、口径、依赖等都写在这里） */
  note?: string
}

/** 当前计划（= 最后一条 `plan` 事件的内容） */
export interface Plan {
  /** 这批任务要做成什么（一句话目标） */
  goal: string
  /** 版本号：首次提交为 1，之后每次成功提交 +1（用于复盘"这份清单改了几版"） */
  revision: number
  /** 完整任务清单 */
  tasks: PlanTask[]
}

/**
 * `plan` 事件的时间线载荷。
 *
 * 刻意**等于 `Plan` 本身**（goal / revision / tasks）：事件是"那一版清单的完整快照"，
 * 前端与复盘只需要读最后一条就能拿到全量视图，不需要把事件序列重放一遍。
 */
export type PlanPayload = Plan

/** 所有会产出计划的工具 key（目前只有一个；将来加规划类工具时在这里登记） */
export const PLAN_TOOL_KEYS: readonly string[] = [TOOL_KEYS.todoWrite]

/**
 * 从任意值里认出「计划」：形状不对就返回 null（**不抛错**）。
 *
 * 用它的两处：① 时间线读"当前计划"；② 运行时从工具出参里认出该落 `plan` 事件的产物。
 * 校验从严：半真半假的计划（缺 revision、状态不在三态里）宁可当没有，
 * 也不要让下游拿到一份"看起来能用"的坏数据。
 */
export const toPlan = (value: unknown): Plan | null => {
  if (!value || typeof value !== 'object') return null
  const raw = value as { goal?: unknown; revision?: unknown; tasks?: unknown }
  if (typeof raw.goal !== 'string') return null
  if (!Number.isInteger(raw.revision) || (raw.revision as number) < 1) return null
  if (!Array.isArray(raw.tasks)) return null

  const tasks: PlanTask[] = []
  const seen = new Set<string>()
  for (const item of raw.tasks) {
    if (!item || typeof item !== 'object') return null
    const task = item as { id?: unknown; title?: unknown; status?: unknown; note?: unknown }
    if (typeof task.id !== 'string' || !task.id) return null
    if (typeof task.title !== 'string' || !task.title) return null
    if (!PLAN_TASK_STATUSES.includes(task.status as PlanTaskStatus)) return null
    if (seen.has(task.id)) return null
    seen.add(task.id)
    tasks.push({
      id: task.id,
      title: task.title,
      status: task.status as PlanTaskStatus,
      ...(typeof task.note === 'string' ? { note: task.note } : {}),
    })
  }

  return { goal: raw.goal, revision: raw.revision as number, tasks }
}

/**
 * 从工具结果里认出「计划」：只有规划类工具（{@link PLAN_TOOL_KEYS}）的出参才落 `plan` 事件。
 *
 * 计划为什么走时间线而不是专用表：**只追加、可复盘** ——
 * 「当前计划」= 最后一条 `plan` 事件；「什么时候把哪一项标成完成」= 事件序列。
 * 工具本身不写库（工具只做校验与计算），运行时只做这一步识别，不引入额外状态。
 */
export const toPlanPayload = (
  toolKey: string | null | undefined,
  output: unknown,
): PlanPayload | null => {
  if (!toolKey || !PLAN_TOOL_KEYS.includes(toolKey)) return null
  return toPlan(output)
}
