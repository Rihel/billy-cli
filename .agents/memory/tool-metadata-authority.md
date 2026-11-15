# 工具元数据权威：catalog（定义）→ gateway（运行时）→ worker（能力）

> **查证优先级：必核** —— 路径 / 导入 / manifest 字段；加工具或改目录后重核。

## 结论（2026-11-14）

- **定义源**：server 的 `@ToolDecl`（Zod / 描述 / scope）是执行期事实源；
  `pnpm gen:tool-catalog` 把它生成到 `packages/tool-catalog/src/generated.ts` 的
  `ALL_TOOL_MANIFESTS`（32 个工具，含 facade / server / worker 三种 executor；
  含 file / skill / memory / planner / subagent）。
- **已迁 worker 的 bash / web-fetch / web-search**：catalog 手写定义，
  server 声明与 gateway 共用；其余工具仍以 server 声明为准，由生成脚本镜像。
- **运行时目录**：gateway `ToolCatalogService` 读 `ALL_TOOL_MANIFESTS`，按 `ai_tools`
  enabled / scope 过滤；不再手写 manifest。
- **server**：`@ToolDecl` 的 `params/title/description` 从 catalog 取；本地工具仍由 server 执行。
- **worker**：只注册 executor key / 版本 / 健康 / 负载；执行器用 catalog 的 params 校验，不报 schema。
- **DB `ai_tools`**：只存 enabled / limits / config / secrets；**不是 schema 来源**。
  gateway 的 `ToolConfigService` 已读它（5s 缓存）：enabled / scope / limits / secrets / config
  合并进 `ToolInvokeRequest.settings`，停用/越权在策略层拒绝；secrets 只走内部请求，不落审计。
- `toToolManifest` 自动补必填 `reason`（模型参数）；catalog 的 `params` 是执行参数（不含 reason），
  gateway 策略校验后会把 reason 摘掉。
- contracts 已删除重复的 bash/web 入参 schema；传输契约只保留 `ToolInvokeRequest` / manifest / worker 注册。

## 当前收口

- server 的 Mastra `resolveTools` 已消费 `GatewayToolCatalog.allowedKeys()`（`/v1/tools/list`）：
  本地注册机负责执行，gateway 目录负责运行时 enabled / scope；未配置或抖动 fail-open。
- **授权按执行分流（2026-11-15 修正）**：只有 `remote.supports(key)`（走网关的 17 个 worker 工具）
  才受网关目录约束；facade / server 的 15 个本地工具以本地注册机 + `ai_tools` 为准。
  纯函数 `filterToolFace`（`runtime/gateway-tool-catalog.ts`）实现，dispatch 与授权同一口径。
  曾全量过滤 → `generated.ts` 滞后时 `wait-sub-agent`（本地工具）也被削掉。
- web-search / web-request / file / skill / memory / read-tool-result 均已进 catalog + worker 执行器。
- 仅剩 connector 动态工具（不在本目标）。

## 核对命令

```bash
grep -n "TOOL_DEFINITIONS\|toToolManifest" packages/tool-catalog/src/index.ts apps/tool-gateway/src/catalog/tool.catalog.ts
grep -n "@repo/tool-catalog" apps/agent-runtime/src/modules/ai/tools/bash.tool.ts apps/agent-runtime/src/modules/ai/tools/web.tools.ts
grep -n "params:" packages/tool-catalog/src/tools/*.ts
grep -n "getToolDefinition" apps/tool-gateway/src/policy/tool.policy.ts
grep -n "ToolConfigService" apps/tool-gateway/src/policy/tool.policy.ts apps/tool-gateway/src/catalog/tool.catalog.ts
```

## 失效信号

出现第二份手写 manifest / server 与 gateway 各写参数 / worker 上报 schema / `ai_tools` 存 schema；
任一出现都要回来改卡片。
