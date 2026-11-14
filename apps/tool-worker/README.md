# tool-worker

内部数据面：**只执行工具**，不连主库、不持 provider key。

当前接 `bash` / `web-fetch` / `web-request` / `web-search` / `memory-*` / `file-*` / `read-tool-result`；`skill-*` 回 server（admin 控制面）：

- `POST /v1/exec`：`@repo/contracts` 的 `ToolInvokeRequest` → `ToolInvokeResponse`；
- `GET /healthz` / `GET /readyz`：进程 / 沙箱 + Redis；
- 启动向 Redis 注册自己（能力、端点、负载），心跳 10s、30s 过期。

## 目录

```
src/
  config/app-config.ts
  executors/
    tool.executor.ts        # 一个工具 key 一个执行器的契约
    executor.registry.ts    # 注册 / 按 key 分发（tools() 供注册表上报）
    bash.executor.ts
  tools/web/web-fetch.executor.ts
  tools/web/web-search.executor.ts
  tools/web/web-request.executor.ts
  tools/memory/memory.executor.ts
  tools/skill/skill.executor.ts
  tools/file/file.executor.ts
  tools/read-tool-result.executor.ts
  worker.controller.ts / worker.registry.ts / worker.service.ts
```

新增工具 = 新写一个 `ToolExecutor` provider + 在 `ToolExecutorRegistry` 注册；`WorkerRegistry`
上报的 `tools` 自动来自注册表，不会出现“说支持、实际没有”。

## 本地跑

```bash
cp .env.example .env
pnpm --filter @repo/contracts build
pnpm --filter @repo/web-runtime build
pnpm --filter @app/tool-worker dev
```

需要本机有 Redis；命令沙箱用 `@repo/kits` 的 `WorkspaceRuntimeService`（Linux bwrap / macOS
sandbox-exec）。沙箱不可用时按 `fail closed` 拒绝执行。

## 边界

- 不做授权 / 限流 / 审计（在 tool-gateway）；
- 工作区是**临时目录**，可丢弃；真相在工作区对象存储（后续接 S3）；
- `web-fetch` 配置走 env（`TOOL_WEB_FETCH_*`），worker 不读 DB；分页 ref 是进程内缓存，
  gateway 用 Redis `ai:web-fetch-ref:<ref>` 把后续翻页路由回同一个 worker；
- `web-search` 密钥优先用 gateway 下发的 `settings.secrets.apiKey`（来自 `ai_tools`），
  worker 的 `TOOL_WEB_SEARCH_API_KEY` 只是部署级兜底；
- `memory-*` **直连 PG**（`@repo/ai-data` 的 MemoryService/Repository）；
- worker 的 DB 账号用 `TOOL_WORKER_DB_URL`，最小权限角色见 `scripts/sql/tool-worker-role.sql`；
- `read-tool-result` **直连 Redis + PG timeline**，不再回调 server；
- `file-*` 直连 PG/OSS，保留原有 FileService 行为；workspace 与 bash 共用 `TOOL_WORKER_WORKSPACE_ROOT`（本地指向原 workspace，现有文件仍可见）；
- `read-tool-result` 通过 `/internal/ai/tool-result/execute` 调 server 取页（全文在 server 内存 / 时间线）；
  `SERVER_INTERNAL_URL` 指向 server，内部令牌与 gateway 共用；
- 生产必须改 `TOOL_INTERNAL_TOKEN`；多租户不要设 `AGENT_WORKSPACE_MODE=off`。
