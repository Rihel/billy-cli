# read-tool-result 已改 worker 直连 Redis/PG（旧 API 删除）

> 查证优先级：必核 —— 确认 worker 不再调控制面 HTTP。

## 现状（2026-11-14）

- `read-tool-result` 由 worker 的 `ReadToolResultExecutor` 直接读 Redis
  `ai:tool-result:<conversationId>:<toolCallId>`；未命中时回查 `timelines`。
- 分页全文由 **agent-runtime** 写入 Redis（TTL 1h），worker 只读。**注意：`PaginatePlugin` 已删**
  （见 `runtime-cleanup`），现在是 Mastra 适配层 / 上下文层直接调 `paginate + toModelPage`
  （`mastra/tool.adapter.ts`、`runtime/context.service.ts`）。
- 取页越权 / 每轮上限在 worker 内校验。
- 旧 `/internal/ai/tool-result/execute`、`ToolResultDataClient`、`InternalToolResult*` 已删除。
- 数据流单向：worker → Redis/PG。
