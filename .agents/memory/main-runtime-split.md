# main / agent-runtime 拆分后的架构与已知缺口

> 查证优先级：**必核** —— 端口、脚本、边界都会继续动；用前跑「核对」三条。

## 结论（2026-11-14）

- **两个 Nest 应用**：`apps/main`（`@app/main`，9989，公网 BFF）与 `apps/agent-runtime`
  （`@app/agent-runtime`，9990，只跑 agent loop）。前端只连 main。
- **main**：auth / user / admin / session / storage / share / monitor / ops / config、全部 AI CRUD
  （ai-model / ai-tool / ai-skill / ai-connector / ai-memory / conversation / run / timeline / usage）、
  `/agent/*` 的 SSE 中继与 `/agent/file/*`（含 `workspace-content`）。
- **runtime**：只有 `/internal/agent/{chat/stream, chat/resume, run/stop, run/stream, run/:runId/stream}`
  与 `/healthz`、`/readyz`、`/info`；无 public controller / 用户鉴权，只校验 `x-internal-token`
  （`AGENT_INTERNAL_TOKEN`）+ `x-user-id` / `x-admin-id` / `x-main-client-id`。
- **输出**：runtime 每段 chunk 发 Redis pub/sub 频道 `agent:stream:client:<clientId>`（2026-11-15 起，
  之前是 Kafka `agent.run.events`）；main `AgentSseBridge` 订阅后写 SSE，`final` → `[DONE]`。
  详见 [sse-transport](sse-transport.md)。
- **配置事件**：`ai.skill.changed` 走 Redis EventBus（runtime 落盘 + 启动全量 sync 兜底）；
  `ai.connector.sync` 走 Redis + Kafka 双发（runtime 按 `connectorId + requestedAt` 幂等）。
- **已补**：`run/stop`、`chat/resume`、`GET /agent/run/stream` 重连；file 的 HTTP 在 main，
  runtime 只有文件工具执行侧。`dev:stack` 起全套，`kill:start` 端口含 9990。

## 已知缺口（核实过的现状）

1. `db:gen` / `db:migrate` 已收归 `@repo/db`；`seed:admin` 由 `@app/main` 执行。
2. 非流式 `POST /agent/chat` 无服务端路由，但 `@repo/sdk` 的 `chat()` 仍在请求它 → 404。
3. 重连是 runtime 的 Redis 输出记录补发，不是 broker 回放；Redis 丢键 / runtime 重启后不可续。
5. 拆分后 `apps/main/test` 只剩 5 个用例，auth / storage / share 单测未迁入（缺失，不是通过）。
6. AI 对话无限流 / 无准入（main 的 `/agent/chat/stream` 只有 `AnyAuthGuard`）。

## 核对

```bash
ls apps; grep -rn "@Controller" apps/main/src apps/agent-runtime/src | sed 's/:.*@Controller/ -> /'
grep -n "AGENT_RUNTIME_URL\|AGENT_INTERNAL_TOKEN\|KAFKA_BROKERS" apps/main/.env.example
grep -n "AGENT_INTERNAL_TOKEN" apps/agent-runtime/.env | head -1
```

## 依据

`docs/guide/backend.md`、`docs/design/distributed-ai-architecture.md` 0.1 节、`apps/main/src/agent/*`、
`apps/agent-runtime/src/modules/ai/api/agent-internal.controller.ts`、
`packages/shared/src/schema/agent-stream-frame.schema.ts`；端口与脚本以根 `package.json` 为准。

## 失效信号

再拆 / 合 app、model-gateway 落地、SSE 回传再换（Kafka / 内部 SSE 中继）、db 脚本搬到 main、内部令牌改成正式鉴权。
