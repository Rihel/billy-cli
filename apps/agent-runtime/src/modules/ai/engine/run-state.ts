/**
 * Run 状态机（设计 §4.3 的状态图）。
 *
 * 状态值来自 `RunStatus` 字典；这里只做**纯函数**判断，不碰数据库 ——
 * 落库路径仍由 `RunRepository` 的条件更新 / 唯一索引保证并发安全。
 * 引擎层用它识别"终态不应再被普通 finish 覆盖"这类异常。
 */
export type RunState =
  | 'pending'
  | 'running'
  | 'suspended'
  | 'succeeded'
  | 'failed'
  | 'interrupted'
  | 'canceled'

/** 每个状态允许的下一跳（与设计文档的状态图逐条对应） */
const TRANSITIONS: Record<RunState, readonly RunState[]> = {
  pending: ['running', 'canceled', 'failed'],
  running: ['suspended', 'succeeded', 'failed', 'canceled', 'interrupted'],
  // 挂起后只能"续跑"（回 running）或被取消 / 失败收尾
  suspended: ['running', 'canceled', 'failed'],
  // 中断的运行可以被恢复（回 running），也可以被判失败 / 取消
  interrupted: ['running', 'canceled', 'failed'],
  succeeded: [],
  failed: [],
  canceled: [],
}

const TERMINAL: ReadonlySet<string> = new Set(['succeeded', 'failed', 'canceled'])

/** 是否是已知状态（字符串来自数据库，可能是历史脏值） */
export const isRunState = (value: string): value is RunState =>
  Object.prototype.hasOwnProperty.call(TRANSITIONS, value)

/** 终态：不再接受普通状态变更（恢复 / 重试 = 新 run） */
export const isTerminalRunState = (value: string): boolean => TERMINAL.has(value)

/** 这条状态迁移是否合法；未知状态一律 false（不猜） */
export const canTransitionRunState = (from: string, to: string): boolean =>
  isRunState(from) && isRunState(to) && TRANSITIONS[from].includes(to)
