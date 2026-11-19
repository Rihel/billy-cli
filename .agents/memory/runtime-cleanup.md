# runtime 只做编排：能力全部来自目录

> **查证优先级：必核** —— 能力数 / 工具面口径 / 发现机制；改装配或提示词后重核。

## 结论（2026-11-20，分布式口径）

- **runtime 不再持有能力执行体，也不持有能力定义**：`bash` / 联网 / 文件 / 记忆 / 取页由服务侧
  `@CapabilityDecl` 定义；runtime 的 `tools/definitions/*`、5 个执行体（约 1,430 行）、
  `core/tools/workspace.ts`、`tool-result.store.ts`、`paginate.plugin.ts` 已删。
- **工具面** = 本地编排工具（规划 / 子 agent / 技能库 / 网关任务工具）+ 能力目录里 `source='code'` 的能力
  （`common-capability`、`workspace-service`、网关内建）。目录能力一律经网关执行，本地不跑插件链。
- **外部服务（`source='manual'`，MCP / 手工登记）不随工具面下发**：模型先用 `tool-search` 找，
  命中 key 记进会话（Redis `ai:tool:discovered:<conversationId>`，7 天 / 最多 50 个），
  **下一轮**由 `resolveTools` 补进工具面。子 agent **不含**外部服务。
- **提示词**：首轮由 `AgentChatService.renderInstructions` 渲染 —— 本地注册机 `describe()` +
  目录里 `source='code'` 的能力；落 `system` 快照后逐字复用。`tools.eta` 明确写「外部服务用 tool-search 找」。
- **授权只剩 key / `'*'`**：`ToolSelector` / `{ category }` / `EXTERNAL_TOOLS` / `tool-selector.ts` 已删；
  注册机 `expand()` 对未知 key 跳过（目录能力由装配层解析），启动期不再校验能力 key 的拼写。
- **`CapabilityInfo` 带 `source`**（`code` / `manual`）：runtime 靠它区分「随工具面下发」与「搜到才下发」。
- **控制面不再存快照**：main 的 `tool-manifests.ts`（1,348 行）已删，`ToolAdminCatalog` 改为
  问 runtime `/internal/agent/tools`（内建工具）+ 网关目录（服务能力），5s 缓存、任一不可用只降级。
- **`/agent/instructions` 预览**与对话首轮共用 `renderAgentInstructions`（含目录能力），不会再出现
  "页面只有本地工具、对话里有全部能力"的两套。
- **k8s**：`billy-agent-runtime` ConfigMap 已补 `TOOL_GATEWAY_URL`（此前只有 compose / 本地 `.env` 有，
  k8s 会退化成没有能力可用）。

## 依据

2026-11-20 改造（契约 + 网关目录 + runtime 装配 + 提示词）；`pnpm --filter @app/agent-runtime test` 505 条全绿。

## 核对命令

```bash
grep -rn "@CapabilityDecl(" apps/common-capability/src apps/workspace-service/src | wc -l
grep -n "source: service.source\|source: 'code'" apps/capability-gateway/src/registry/service.registry.ts
grep -rn "createCapabilityTool" apps/agent-runtime/src/modules/ai/ai.module.ts apps/agent-runtime/src/modules/ai/runtime/chat.service.ts
grep -n "TOOL_GATEWAY_URL" k8s/10-configmap.yaml
cd apps/agent-runtime && pnpm test
```

## 失效信号

外部服务又改成随工具面全量下发 / 能力定义重新回到 runtime / `tool-search` 发现机制被删 /
k8s 的 `TOOL_GATEWAY_URL` 被移除；任一出现都回来改卡片。
