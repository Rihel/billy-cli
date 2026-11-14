# memory 已改为 worker 直连 DB（旧内部 API 已删除）

> 查证优先级：必核 —— 确认没有 worker→控制面的反向调用。

## 现状（2026-11-14）

- `memory-save/search/forget` 由 worker 的 `MemoryExecutor` 直接调用 `@repo/ai-data` 的
  `MemoryService` / `MemoryRepository`，直连 PG（受限账号）。
- 旧的 `/internal/ai/memory/execute`、`MemoryDataClient`、`InternalMemoryRequest` 已删除。
- 数据流单向：gateway → worker → PG。
