# tool-gateway 控制面（bash 已闭环）

> **查证优先级：必核** —— 路由 / 策略 / 审计落点；改 gateway 或 runtime 的远程开关后重核。

## 结论（2026-11-14）

- 目录：`GET/POST /v1/tools/list` 返回 manifest（bash / web-fetch），按 caller 的 scope 过滤；
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
- worker：仍只接 bash；web / file / skill / memory 待迁。

## 关键位置

| 位置 | 内容 |
| --- | --- |
| `apps/tool-gateway/src/tool.catalog.ts` | 静态 manifest + scope 过滤 |
| `apps/tool-gateway/src/internal-token.guard.ts` | 内部令牌 Guard |
| `apps/tool-gateway/src/tool-call.interceptor.ts` | 策略 pre/短路 + 审计 post |
| `apps/tool-gateway/src/zod-body.pipe.ts` | 契约 Pipe |
| `apps/tool-gateway/src/policy/tool.policy.ts` | enabled / scope / validate / rate-limit（域服务） |
| `apps/tool-gateway/src/config/tool.config.service.ts` | 读 `ai_tools` + 5s 缓存 |
| `apps/tool-gateway/src/tool.audit.ts` | 写 `ai_tool_audit` |
| `apps/agent-runtime/src/modules/ai/core/tools/tool.gateway.ts` | 远程 allowlist 在插件链前短路 |
| `packages/db/src/migrations/1794800000000-AiToolAudit.ts` | 审计表 |

## 核对命令

```bash
grep -n "v1/tools/list" apps/tool-gateway/src/gateway.controller.ts
grep -n "UseGuards\|UseInterceptors\|ZodBodyPipe" apps/tool-gateway/src/gateway.controller.ts
grep -n "rateLimitPerMinute" apps/tool-gateway/src/app-config.ts apps/tool-gateway/src/tool.policy.ts
grep -n "ai_tool_audit" apps/tool-gateway/src/tool.audit.ts packages/db/src/migrations/1794800000000-AiToolAudit.ts
grep -n "remote?.supports" apps/agent-runtime/src/modules/ai/core/tools/tool.gateway.ts
```

## 失效信号

插件链全量迁完 / web 等工具迁 worker / 目录改为 DB + 事件失效 / 审计表结构变化；
任一出现都要回来改卡片。
