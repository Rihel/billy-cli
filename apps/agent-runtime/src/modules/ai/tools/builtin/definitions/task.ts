import dedent from 'dedent'
import { z } from 'zod'

/** `wait-task` 的参数：拿长任务的当前快照（可长轮询） */
export const WAIT_TASK_PARAMS = z.object({
  taskId: z.string().min(1).max(128).describe('任务 id（bash 等 task 能力的受理结果里给的 id）'),
  waitMs: z
    .number()
    .int()
    .positive()
    .max(120_000)
    .optional()
    .describe('最多等多久（毫秒）；省略 = 立即返回当前快照，不要空转轮询'),
})

export const WAIT_TASK_TOOL = {
  key: 'wait-task',
  title: '等任务结果',
  category: 'core',
  scope: 'all',
  executor: 'gateway',
  version: 1,
  params: WAIT_TASK_PARAMS,
  description: dedent`
    查询一个长任务（bash 这类 task 能力）的当前状态；没结束时会最多等 waitMs 再返回。

    **什么时候用**：工具结果里带 \`task.id\` 时（受理即返回），用它拿结果；
    不要连着发好几个相同的查询——传 waitMs 让它等。

    **返回**：\`state\`（pending / running / succeeded / failed / canceled / expired）+ \`data\` / \`result\` / \`error\`。
    \`expired\` 表示任务丢了（进程重启或超过保留期），重跑一次原工具即可。
  `,
} as const

/** `tool-search` 的参数：自然语言检索工具 */
export const TOOL_SEARCH_PARAMS = z.object({
  query: z.string().min(1).max(200).describe('要找的工具做什么（自然语言，中文 / 英文都行）'),
  limit: z.number().int().min(1).max(20).optional().describe('返回几个候选（默认 8）'),
})

/** `tool-search` 的模型面定义 */
export const TOOL_SEARCH_TOOL = {
  key: 'tool-search',
  title: '检索工具',
  category: 'core',
  scope: 'all',
  executor: 'gateway',
  version: 1,
  params: TOOL_SEARCH_PARAMS,
  description: dedent`
    按关键词从能力目录里找工具；不确定该用哪个工具、或工具很多时先搜一下。

    返回命中的工具 key 与说明（不是完整参数 schema）；命中后直接用那个工具。
  `,
} as const

/** `cancel-task` 的参数：按 id 取消（幂等） */
export const CANCEL_TASK_PARAMS = z.object({
  taskId: z.string().min(1).max(128).describe('要取消的任务 id'),
})

export const CANCEL_TASK_TOOL = {
  key: 'cancel-task',
  title: '取消任务',
  category: 'core',
  scope: 'all',
  executor: 'gateway',
  version: 1,
  params: CANCEL_TASK_PARAMS,
  description: dedent`
    取消一个还在跑的长任务（用户叫停、或发现参数错了）。幂等：任务已结束就返回当前快照，不报错。

    **什么时候不用**：不确定还要不要结果时先 \`wait-task\` 看一眼。
  `,
} as const
