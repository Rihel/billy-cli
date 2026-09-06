# 响应与错误契约（develop-backend-api 引用文件）

> 本文件是 `develop-backend-api` skill 的组成部分，由主 SKILL.md 引用。
> 写任何后端接口前先读本文件——它是其它所有维度的地基。

- 统一响应结构 `AppResponse<T> = { code, message?, data? }`：`ResponseUtils.success(data)`
  → `code: 0`；`ResponseUtils.error(code, message)`（定义在 `packages/shared/src/app-response.ts`）。
- 路由层返回用 `success(context, data)`（`apps/server/src/lib/http.ts`），HTTP 200；
  入参校验 `jsonBody(Schema)`（zValidator）失败返回 body `code: 400` + `parseZodIssues` 详情。
- 业务错误：service / repository 抛 `AppError` 子类（`code` 必须是 `AppErrorCodes` 已注册值）；
  `main.ts` 的 `app.onError` → `errorHandler` → `mapError` 按错误码映射**真实 HTTP 状态**
  （白名单 400 / 401 / 403 / 404 / 409 / 429 / 500，来自错误码的 `http` 字段）；
  未注册 / 未知错误兜底 `5001 系统错误`（HTTP 500）——**业务错误必须抛已注册的 AppError**，
  否则拿不到准确 code（抛裸 Error / `new Error` 会被当成未知错误处理成 5001，错误语义丢失）。
- 分页：service 返回 `PageQueryResult` / `CursorQueryResult`（`@repo/kits`），
  页面 / SDK 层再包 `AppPageQueryResponse` / `AppCursorQueryResponse`。
