import { createDict } from '../utils'

/**
 * 工具引擎的字典（设计 `docs/design/ai-agent-tool-engine.md` §5.2 / §5.4 / §5.5）。
 *
 * 术语：**注册工具** = 代码里声明、经注册机登记的工具；**runtime 工具** = 运行时（Mastra）
 * 自带、不进注册机的工具（技能那三个），只做边界登记，不受开关与限额控制。
 */

/** 工具类别：来源与治理方式不同 */
export const ToolCategory = createDict({
  /** core bean 交出的运行时能力（规划 / 子 agent / 命令执行） */
  Core: { label: '运行时能力', value: 'core' },
  /** 绑定单一业务模块的业务工具 */
  Business: { label: '业务工具', value: 'business' },
  /**
   * 运行时自带（Mastra 的技能工具 `skill` / `skill_search` / `skill_read`）：
   * 不进注册机，网关拦不到，后台只读展示（设计 §5.10 路线 A）
   */
  Runtime: { label: '运行时自带', value: 'runtime' },
})

/** 工具作用域：这一次调用允不允许（授权在 agent 声明里，作用域是第二层闸门） */
export const ToolScope = createDict({
  All: { label: '所有调用者', value: 'all' },
  Admin: { label: '仅管理员', value: 'admin' },
  User: { label: '仅前台用户', value: 'user' },
  /** 只给 `allowedAgents` 里的 agent（子 agent 沿用父的判定） */
  Agent: { label: '指定 agent', value: 'agent' },
})

/** 配置行的来源：种子同步来的 vs 人工改过的（人工的不被种子覆盖） */
export const ToolSource = createDict({
  Seed: { label: '代码声明', value: 'seed' },
  Manual: { label: '人工修改', value: 'manual' },
})

/** 工具被拒绝的原因（统一结论 `ToolOutcome.reason`，也是时间线 `state` 的依据） */
export const ToolDenyReason = createDict({
  UnknownTool: { label: '工具不存在', value: 'unknown-tool' },
  InvalidInput: { label: '入参不合法', value: 'invalid-input' },
  PrecheckFailed: { label: '前置条件不满足', value: 'precheck-failed' },
  Disabled: { label: '已被管理员关闭', value: 'disabled' },
  Forbidden: { label: '无权限调用', value: 'forbidden' },
  RateLimited: { label: '调用过于频繁', value: 'rate-limited' },
  Timeout: { label: '执行超时', value: 'timeout' },
  Aborted: { label: '已被停止', value: 'aborted' },
  Internal: { label: '执行失败', value: 'internal' },
})

/** 时间线上 `tool-result` 行的状态（`timelines.state`） */
export const ToolResultState = createDict({
  Available: { label: '有结果', value: 'output-available' },
  Error: { label: '执行出错', value: 'output-error' },
  /** 网关拒绝（关掉 / 无权限 / 限流 / 前置条件不满足） */
  Denied: { label: '被拒绝', value: 'denied' },
  /** 入参不合法 */
  Invalid: { label: '入参不合法', value: 'invalid' },
  /** 未知工具（模型编出来的名字） */
  UnknownTool: { label: '未知工具', value: 'unknown-tool' },
})
