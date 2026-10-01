/**
 * 网关插件（设计 §5.4）：**一个插件一个文件**（单一职责铁律）。
 *
 * 这里只导出类，**不在模块里 new**：插件有依赖（限流计数器、日志、结果存储），
 * 装配在 `ai.module.ts` 的 `AGENT_TOOL_PLUGINS` 工厂里做 —— 那里一眼能看到顺序。
 */
export { EnabledPlugin } from './enabled.plugin.js'
export { ScopePlugin } from './scope.plugin.js'
export { RateLimitPlugin } from './rate-limit.plugin.js'
export { ValidatePlugin } from './validate.plugin.js'
export { PrecheckPlugin } from './precheck.plugin.js'
export { AuditStartPlugin } from './audit-start.plugin.js'
export { RedactPlugin } from './redact.plugin.js'
export { PaginatePlugin } from './paginate.plugin.js'
export { AuditEndPlugin } from './audit-end.plugin.js'
