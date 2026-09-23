/**
 * 工具 **key** 的**唯一事实源**：工具 bean 用它声明 `key`，agent 定义用它做授权。
 *
 * 「key」是稳定对外标识（与 agent key 同一套词汇）；Mastra 的 `createTool({ id })` 是它的接口字段，
 * 装配处做一次映射（值相同），不把它的词引进我们的领域。
 *
 * 不把 key 写成裸字符串：agent 授权写错工具名，过去只会在运行时表现为「模型少了个能力」，
 * 现在是编译期错误（符号写错直接 undefined → 类型检查就红）。
 */
export const TOOL_KEYS = {
  listTodos: 'list-todos',
  getTodo: 'get-todo',
  createTodo: 'create-todo',
  /** 规划能力：写出 / 更新执行计划（全量覆盖语义，与 Mastra 的 task_write 一致） */
  writePlan: 'write-plan',
  /** 子 agent 能力：**运行期动态创建一个子 agent 并跑完**（提示词由主 agent 现写，§3.14.2） */
  runSubAgent: 'run-sub-agent',
} as const

/** 工具 key 联合类型（`ToolBuilder` 与 agent 声明的入参类型） */
export type ToolKey = (typeof TOOL_KEYS)[keyof typeof TOOL_KEYS]
