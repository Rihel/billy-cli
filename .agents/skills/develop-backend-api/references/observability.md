# 可观测性：日志 / 指标 / 告警（develop-backend-api 引用文件）

> 本文件是 `develop-backend-api` skill 的组成部分，由主 SKILL.md 引用。
> 需要记录业务事件、排查线上问题、确认告警覆盖时必读。

考虑什么：接口上线后怎么定位问题——靠日志、链路 id、指标与告警，不靠现场复现。
仓库落地：

- 请求链路已全局处理，**不要自写请求日志**：`requestLogger`（`apps/server/src/lib/request-logger.ts`）
  为每个请求生成 `requestId`（nanoid）并写响应头 `X-Request-Id`，按状态分级记录
  （<400 info / 4xx warn / 5xx error，含耗时、userId、ip）；排障时用 `X-Request-Id` 关联一次请求。
- 业务事件结构化日志：`@Logger()`（`@repo/kits`）注入 `AppLogger`，关键写动作记
  `logger.log('<域>.<动作>', { ... })`（参考 todo：`todo.created` / `todo.updated` /
  `todo.removed`）——事件名语义化、上下文放对象里便于检索。
- 错误兜底：路由抛错统一走 `onError`（映射 code/http + 异步告警 `AlertTrigger.notifyError`），
  业务侧**不要**自己 console.error 后吞掉；需要特殊告警 / 重试的失败在 handler 内按需处理。
- 指标：`makeRequestMetrics`（`features/monitor.ts`）已全局埋点，无需每个接口自建。

检查项：关键动作有业务事件日志；异常能被日志 + 告警覆盖；日志无敏感信息（token / 密码 / 密钥）。
