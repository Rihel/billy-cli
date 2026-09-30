/**
 * 工具 **key** 的**唯一事实源**：工具 bean 用它声明 `key`，agent 定义用它做授权。
 *
 * 「key」是稳定对外标识（与 agent key 同一套词汇）；Mastra 的 `createTool({ id })` 是它的接口字段，
 * 装配处做一次映射（值相同），不把它的词引进我们的领域。
 *
 * 不把 key 写成裸字符串：agent 授权写错工具名，过去只会在运行时表现为「模型少了个能力」，
 * 现在是编译期错误（符号写错直接 undefined → 类型检查就红）。
 *
 * 当前只有**运行时能力**（core bean 交出的工具）：AI 模块已与业务模块解耦，
 * 业务工具一个都没有（`AGENT_TOOLS` 保留为空数组，是将来加业务工具的扩展点）。
 */
export const TOOL_KEYS = {
  /**
   * 规划能力：提交**完整任务清单**（全量覆盖语义）——
   * 加任务 / 删任务 / 改状态 / 重规划都由同一份清单的不同版本表达。
   */
  todoWrite: 'todo-write',
  /** 子 agent 能力：**运行期动态创建一个子 agent 并跑完**（提示词由主 agent 现写） */
  runSubAgent: 'run-sub-agent',
} as const

/** 工具 key 联合类型（`ToolBuilder` 与 agent 声明的入参类型） */
export type ToolKey = (typeof TOOL_KEYS)[keyof typeof TOOL_KEYS]
