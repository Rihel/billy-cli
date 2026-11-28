# AI 运行期关键链路地图

> **查证优先级：抽核** —— 主体是路径与归属，结构调整不频繁。
> 若 `apps/agent-runtime/src/modules/ai` 近期有改动，先看一眼再采用：
> `git log --oneline -5 -- apps/agent-runtime/src/modules/ai`。

## 结论

| 要做的事 | 去哪个文件 |
| --- | --- |
| 组装一次模型输入（含摘要注入、是否需要压缩） | `runtime/context/context.service.ts`（`buildInput`；组装入口在 `runtime/context/runtime-context.builder.ts`） |
| 会话编排、压缩判定与调用 | `runtime/agent/chat.service.ts`（一轮编排；上下文组装在 `runtime/context/`） |
| 时间线落库与读取 | `runtime/run/timeline.repository.ts`（`timelines` 表，`kind` 见 `TimelineKind`） |
| 短期记忆（Mastra thread） | `adapters/mastra/agent-memory.ts`（2026-11-14 起 Redis）+ `runtime/agent/chat.service.ts` 建 thread |
| 技能加载 | `tools/skills/skill.loader.ts`（扫 `tools/skills/catalog/`；当前有内置 `html-page`，另加载 `~/.agents/skills`） |
| 技能交给 Mastra | `adapters/mastra/skill.adapter.ts`（`toMastraSkills`） |
| 工具注册与网关 | `core/tools/tool.registry.ts`（只存编排工具）、`tool.gateway.ts`（远程分流 + tool-search 发现 + 三段生命周期分派）、`external.tool.ts`（目录能力）；插件在 `core/tools/plugins/`，契约 `ToolLifecyclePhase` = `before / denied / after`（2026-11-22 收敛，见设计 §5.4）；收尾链拿 `ToolPhaseContext`，`outcome` 只读、改内容只能用 `setOutcomeData`（网关运行期还会兜底拦截改写结论） |
| 子 agent 并发闸门 | `runtime/agent/agent-runner.ts` + `foundation/constants.ts`（`SUB_AGENT_MAX_CONCURRENT = 3`） |
| 用量统计 | `runtime/run/usage.ts`，汇总在 `modules/ai-usage`（表 `ai_usage_daily`） |
| agent 规格 / 提示词 / 工具选择器 / 技能类型 | **只在 runtime**：`domain/agents/*.agent.ts`、`foundation/prompts/**`、`tools/engine/tool-keys.ts`、`tools/skills/skills.types.ts` |
| main 要 agent 清单 / 状态 / 静态指令 | 经 `@repo/internal-sdk` 的 `AgentRuntimeClient` 调 `/internal/agent/{status,list,instructions}`（`apps/main/src/agent/agent-catalog.service.ts`，缓存 30s） |
| 监控引擎（采集 / 规则 / 告警） | `@repo/monitor`（`packages/monitor/src`）；HTTP 在 `apps/main/src/modules/monitor/api` |

短期记忆的现状：生产 `@mastra/redis`（单测仍用 `InMemoryStore`）、`lastMessages: 20`、
`semanticRecall: false`、`workingMemory: false`；只服务 durable 续跑，真相在 `timelines`。
长期记忆：`ai_memories` 表 + `modules/ai/memory/**`（2026-11-14）。

## 依据

上述路径均在 2026-10-25 逐个打开核对过。

## 失效信号

目录结构调整后请直接改这张表；`catalog/` 目录被建起来时，技能一行要改写。
