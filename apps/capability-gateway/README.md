# capability-gateway

能力网关（内部，9993）：**能力目录 / 授权过滤 / 调用路由 / 限流校验 / MCP client / 审计**，不执行能力。

执行在 `common-capability`（服务 `common`，9 个能力）与 `workspace-service`（服务 `workspace`，8 个能力）；
网关按 Redis 注册表选实例，再直连该实例上报的 endpoint 转发 `/invoke`（没有静态 worker 兜底地址）。

## 职责与接口

- **登记 / 心跳**：`POST /v1/services/register`、`POST /v1/instances/heartbeat`、
  `POST /v1/instances/deregister`、`POST /v1/services/deregister`；
- **目录 / 调用**：`POST /v1/capabilities/list`（按调用身份 + 服务授权过滤）、`POST /v1/capabilities/invoke`
  （治理 → 路由 → 审计），任务 `POST /v1/tasks/get|cancel|cancel-run`；
- **后台**：`POST /v1/services/list`、`POST /v1/services/status`、`POST /v1/services/mcp/list`；
- **内建能力**（进程内处理，不登记给任何服务）：`wait-task` / `cancel-task` / `tool-search`；
- 每次 invoke 写 `ai_tool_audit`；登记记录落 `ai_capability_services`（DB 是事实源，Redis 只是运行时快照）；
- `GET /healthz` / `GET /readyz`（readyz 探 Redis）。

## 配置

见 `.env.example`：`PORT` / `DB_URL` / `REDIS_URL` / `TOOL_INTERNAL_TOKEN` /
`TOOL_WORKER_STALE_MS` / `TOOL_GATEWAY_TIMEOUT_MS` / `TOOL_GATEWAY_RATE_LIMIT_PER_MINUTE` /
`TOOL_GATEWAY_ALLOW_PRIVATE_NETWORK`。完整说明见 [docs/guide/env.md](../../docs/guide/env.md)。

## 本地跑

```bash
cp .env.example .env
pnpm --filter @repo/contracts build
pnpm --filter @repo/internal-sdk build
pnpm --filter @repo/db build
pnpm --filter @app/common-capability dev      # 另一个终端
pnpm --filter @app/workspace-service dev      # 另一个终端（bash / 文件能力）
pnpm --filter @app/capability-gateway dev
```

验证目录：

```bash
curl -s -X POST http://127.0.0.1:9993/v1/capabilities/list \
  -H 'content-type: application/json' -H 'x-internal-token: dev-tool-token' \
  -d '{"caller":{"conversationId":"c1","runId":"r1","userId":"u1","isAdmin":true,
       "agentKey":"assistant","rootAgentKey":"assistant","depth":0}}'
```

## 规则

所有 app 间调用只走 `@repo/internal-sdk` 的 typed client；业务代码不直接 fetch 内部地址。
新增内部端点：先加 `@repo/contracts`，再加 SDK 方法，最后才给调用方用。
