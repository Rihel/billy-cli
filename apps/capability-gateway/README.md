# capability-gateway

内部工具控制面：**目录 + 策略 + 选 worker + 超时 + 审计**，不执行工具；连主库只写审计。

当前路由 `bash` / `web-fetch` / `web-request` / `web-search` / `memory-*` / `read-tool-result`；`file-*` 暂走 server，`skill-*` 由 server 本地执行：

- `POST /v1/tools/list`：按 caller / agent / 深度返回可用工具 manifest；
- `POST /v1/tools/invoke`：`ToolInvokeRequest` → `ToolInvokeResponse`；
- 每次调用写 `ai_tool_audit`（需要 `DB_URL`）；
- `GET /v1/workers`：当前注册表里看到的 worker（调试 / 运维）；
- `GET /healthz` / `GET /readyz`。

worker 发现走 Redis 注册表（`ai:common-capability:<id>` + `ai:common-capabilitys:alive`）；
注册表为空时回退到 `TOOL_WORKER_URL`。

## 本地跑

```bash
cp .env.example .env
# gateway 需要 DB（写 ai_tool_audit）与 Redis（注册表 + 限流）
pnpm --filter @repo/contracts build
pnpm --filter @repo/internal-sdk build
pnpm --filter @repo/db build
pnpm --filter @app/common-capability dev   # 另一个终端
pnpm --filter @app/capability-gateway dev
```

调一次：

```bash
curl -s http://127.0.0.1:9993/v1/tools/invoke \
  -H 'content-type: application/json' \
  -H 'x-internal-token: dev-tool-token' \
  -d '{"version":1,"requestId":"r1","toolKey":"bash","toolCallId":null,
       "input":{"command":"echo hi"},"caller":{"conversationId":"c1","runId":"run1","userId":"u1","isAdmin":false,
       "agentKey":"assistant","rootAgentKey":"assistant","depth":0},"deadlineMs":10000}'
```

## 目录

```
src/
  main.ts / root.module.ts
  config/app-config.ts          # 环境变量 + zod
  gateway/                      # controller / service / module
  catalog/tool.catalog.ts       # 工具 manifest
  policy/                       # 策略服务 + ToolCallInterceptor
  audit/tool.audit.ts           # ai_tool_audit 写入
  http/                         # InternalTokenGuard + ZodBodyPipe
  workers/worker.directory.ts   # 注册表 + 静态 worker
```

## 规则

所有 app 间调用只走 `@repo/internal-sdk` 的 typed client；业务代码不直接 fetch 内部地址。
新增内部端点：先加 `@repo/contracts`，再加 SDK 方法，最后才给调用方用。
