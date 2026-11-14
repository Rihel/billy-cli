/**
 * 错误语义与全局异常处理：错误码 → HTTP / 中文映射、HTTP 边界错误、全局异常过滤器、
 * 技术错误告警钩子（避免 HTTP 边界层反向依赖业务模块）。
 */
export * from './error-descriptor.js'
export * from './boundary-error.js'
export * from './app-exception.filter.js'
export * from './error-alert-hook.js'
