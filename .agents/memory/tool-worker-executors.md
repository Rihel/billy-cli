# tool-worker 执行器化（bash + web-fetch）

> **查证优先级：必核** —— 工具列表 / 执行器注册 / 远程 allowlist；加工具或改路由后重核。

## 结论（2026-11-14）

- worker 用 `ToolExecutor` 契约（`readonly key` + `execute(ToolInvokeRequest)`），
  `ToolExecutorRegistry` 注册并按 key 分发；`ToolWorkerService` 只做编排。
- 已接：`bash`、`web-fetch`、`web-request`、`web-search`、`memory-*`、`file-*`、`read-tool-result`；`skill-*` 回 server（admin 控制面）。
- `WorkerRegistry.snapshot()` 的 `tools` / `executors` 来自 registry，不再硬编码。
- `web-fetch` 配置在 worker env（`TOOL_WEB_FETCH_*`）；分页 ref 是 worker 进程内缓存，
  gateway 用 Redis `ai:web-fetch-ref:<ref>` 做 30min 亲和，翻页路由回同一 worker。
- runtime 远程 allowlist 默认 `bash,web-fetch`（`TOOL_GATEWAY_TOOLS`）；本地插件链在远程路径前短路。
- `web-search` 密钥优先用 gateway 下发的 `settings.secrets.apiKey`（`ai_tools`），
  `TOOL_WEB_SEARCH_API_KEY` 是部署级兜底；配置 baseUrl/timeout/allowPrivate 来自 `settings.config`。
- `memory-*` 直连 PG（`@repo/ai-data` 的 MemoryService/Repository）。
- `skill-*` 已回 server 本地执行（admin 控制面，不属执行平面）。
- `file-*` 直连 PG + OSS，workspace 用 worker 本地目录。
- `read-tool-result` 直连 Redis + PG timeline，不再回调 server。

## 关键位置

| 位置 | 内容 |
| --- | --- |
| `apps/tool-worker/src/executors/tool.executor.ts` | 执行器契约 |
| `apps/tool-worker/src/executors/executor.registry.ts` | 注册 / 分发 / tools() |
| `apps/tool-worker/src/executors/bash.executor.ts` | bash |
| `apps/tool-worker/src/tools/web/web-fetch.executor.ts` | web-fetch |
| `apps/tool-worker/src/tools/web/web-search.executor.ts` | web-search |
| `apps/tool-worker/src/tools/web/web-request.executor.ts` | web-request |
| `apps/tool-worker/src/tools/memory/memory.executor.ts` | memory-*（RPC server 数据 API） |
| `apps/tool-worker/src/tools/file/file.executor.ts` | file-*（直连 FileService/PG/OSS） |
| `apps/tool-worker/src/tools/read-tool-result.executor.ts` | 取页（RPC server 数据 API） |
| `packages/web-runtime` | 出网 / Markdown / 分页 / 反爬（server + worker 共用） |
| `apps/tool-gateway/src/gateway/gateway.service.ts` | ref 亲和与路由 |
| `apps/agent-runtime/src/modules/ai/runtime/remote-tool.client.ts` | 远程 allowlist 默认值 |

## 核对命令

```bash
grep -n "readonly key\|register(" apps/tool-worker/src/executors/*.ts
grep -n "tools:" apps/tool-worker/src/worker.registry.ts
grep -n "web-fetch-ref" apps/tool-gateway/src/gateway/gateway.service.ts
grep -n "TOOL_GATEWAY_TOOLS" apps/agent-runtime/src/modules/ai/runtime/remote-tool.client.ts
grep -n "TOOL_WEB_FETCH_" apps/tool-worker/src/config/app-config.ts
```

## 失效信号

worker 支持的工具不再来自 registry / web-ref 不再亲和 / 配置改由 gateway 下发 /
web-search 迁 worker；任一出现都要回来改卡片与设计 D5。
