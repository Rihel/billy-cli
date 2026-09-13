/** 技术错误告警上下文（辅助定位） */
export interface ErrorAlertContext {
  path?: string
  requestId?: string
}

/**
 * 技术错误告警钩子：由组合根（RootModule）注入 `AlertTrigger.notifyError`。
 *
 * 抽成 token 而非直接 import `AlertTrigger`，是为了让 common 层（HTTP 边界）不依赖
 * 业务模块 —— 保持「边界层不反向依赖业务」的分层约束。
 */
export const ERROR_ALERT_HOOK = Symbol.for('ErrorAlertHook')

export type ErrorAlertHook = (error: unknown, context: ErrorAlertContext) => void
