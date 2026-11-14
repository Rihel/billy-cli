# file 已改 worker 直连 PG/OSS（旧内部 API 已删除）

> 查证优先级：必核 —— 确认没有 worker→控制面的反向调用。

## 现状（2026-11-14）

- `@repo/ai-data` 收 `FileRepository` / `FileService` / `file.schemas` / workspace 路径工具；
- worker `FileExecutor` 直接执行，PG 存文件元数据，OSS 存对象，workspace 用 worker 本地目录；
- main（`/agent/file/*` HTTP）与 runtime（文件工具）共用 `@repo/ai-data` 的 FileService；
  worker 的 `FileExecutor` 也用它；两 app 的 `database/entities` 只是 re-export；
- 旧 `/internal/ai/file/execute`、`FileDataClient`、`InternalFile*` 已删除；
- 数据流单向：worker → PG/OSS。
