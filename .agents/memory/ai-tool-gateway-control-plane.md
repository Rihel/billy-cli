# tool-gateway 控制面（bash 已闭环）

> **查证优先级：必核** —— 路由 / 策略 / 审计落点；改 gateway 或 runtime 的远程开关后重核。

## 结论（2026-11-15）

- **坑：invoke 路由上「信封 × 审计」的顺序有语义**。控制器必须是
  `@UseInterceptors(ResponseEnvelopeInterceptor, ToolCallInterceptor)`（信封在外）。
  写反时信封先包成 `{code,data}`，审计的 tap 再读 `response.outcome` → TypeError →
  整条工具调用回 500 `5001`，而 worker 其实已执行成功、结论被吞掉，模型只会判定「网络全挂」。
  实测 2026-11-15：会话里 39 条工具结果全是这个 500，`ai_tool_audit` 一条都没写。
  现审计侧用 `businessBodyOf` 拆信封兜底（拿不到 outcome 就 warn 跳过，不毁工具结论）。
- 目录：`GET/POST /v1/tools/list` 返回 manifest，按 caller 的 scope 过滤；
  manifest 来自 `@repo/tool-catalog`，`ai_tools` 的 enabled / scope / allowedAgents 已接入。
- 配置：`ToolConfigService` 读 `ai_tools`（5s 缓存），把 enabled / scope / limits / config /
  secrets / version 合并进 `ToolInvokeRequest.settings`；停用/越权在策略层拒绝。
- 策略：`ToolPolicyService` 做 enabled / scope / validate（catalog 的 Zod）/ rate-limit
  （`limits.rateLimitPerMinute` 覆盖默认 60/min；Redis 抖动 fail-open）。
- Nest 生命周期：`InternalTokenGuard` 令牌 → `ToolCallInterceptor` 策略 pre/短路 + 审计 post
  → `ZodBodyPipe` 契约 → controller；策略步骤仍是 DI 域服务，由 interceptor 调用。
- 审计：每次调用写 `ai_tool_audit`（gateway 唯一写方）；timeline 由 agent-runtime 写。
- 远程执行：agent-runtime 命中 `TOOL_GATEWAY_URL` + `TOOL_GATEWAY_TOOLS` 时，`ToolGateway.invoke`
  **在本地插件链之前**直接走 gateway；策略只有 gateway 一份，避免双限流/双审计。
- 响应：invoke 返回 `{code:0,data:ToolInvokeResponse}` 信封，runtime 用 `requestEnvelope` 解。

## 关键位置

| 位置 | 内容 |
| --- | --- |
| `apps/tool-gateway/src/gateway/gateway.controller.ts` | 路由 + Guard/Pipe/Interceptor 绑定（**顺序有语义**） |
| `apps/tool-gateway/src/catalog/tool.catalog.ts` | 静态 manifest + scope 过滤 |
| `apps/tool-gateway/src/http/internal-token.guard.ts` | 内部令牌 Guard |
| `apps/tool-gateway/src/policy/tool-call.interceptor.ts` | 策略 pre/短路 + 审计 post + `businessBodyOf` 拆信封 |
| `apps/tool-gateway/src/policy/tool.policy.ts` | enabled / scope / validate / rate-limit（域服务） |
| `apps/tool-gateway/src/config/tool.config.service.ts` | 读 `ai_tools` + 5s 缓存 |
| `apps/tool-gateway/src/audit/tool.audit.ts` | 写 `ai_tool_audit` |
| `apps/agent-runtime/src/modules/ai/runtime/remote-tool.client.ts` | runtime 侧远程调用 + 失败归因 |

## 核对命令

```bash
grep -n "UseInterceptors(ResponseEnvelopeInterceptor, ToolCallInterceptor)" \
  apps/tool-gateway/src/gateway/gateway.controller.ts   # 顺序必须是 Envelope 在前
pnpm --filter @app/tool-gateway test                    # 含 envelope-audit 组合用例
psql -h 127.0.0.1 -U root -d billy-cli -c \
  "select created_at, tool_key, status, reason from ai_tool_audit order by created_at desc limit 5"
```

## 失效信号

信封拦截器从 invoke 路由移除 / 审计改到 service 里写 / 插件链全量迁完 / 工具目录改 DB + 事件失效；
任一出现都要回来改卡片。
