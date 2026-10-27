# AI 运行期关键链路地图

> **查证优先级：抽核** —— 主体是路径与归属，结构调整不频繁。
> 若 `apps/server/src/modules/ai` 近期有改动，先看一眼再采用：
> `git log --oneline -5 -- apps/server/src/modules/ai`。

## 结论

| 要做的事 | 去哪个文件 |
| --- | --- |
| 组装一次模型输入（含摘要注入、是否需要压缩） | `runtime/context.service.ts`（`buildInput` / `buildContext`，`:176` 读 `latestSummary`） |
| 会话编排、压缩判定与调用 | `runtime/chat.service.ts`（`buildContext` 调用点约 271、900 行） |
| 时间线落库与读取 | `runtime/timeline.repository.ts`（`timelines` 表，`kind` 见 `TimelineKind`） |
| 短期记忆（Mastra thread） | `mastra/agent-memory.ts` + `chat.service.ts:184` 建 thread |
| 技能加载 | `core/skills/skill.loader.ts`（扫 `core/skills/catalog/`，该目录当前不存在 → 装载 0 个技能） |
| 技能交给 Mastra | `mastra/skill.adapter.ts`（`toMastraSkills`） |
| 工具注册与网关 | `core/tools/tool.registry.ts`、`core/tools/tool.gateway.ts`，插件在 `core/tools/plugins/` |
| 子 agent 并发闸门 | `runtime/agent-runner.ts` + `core/constants.ts:30`（`SUB_AGENT_MAX_CONCURRENT = 3`） |
| 用量统计 | `runtime/usage.ts`，汇总在 `modules/ai-usage`（表 `ai_usage_daily`） |

短期记忆的现状：`InMemoryStore`、`lastMessages: 20`、`semanticRecall: false`、`workingMemory: false`，
进程重启即丢，目前只服务 durable 续跑（`agent-memory.ts` 注释里自己标为已知缺口）。

## 依据

上述路径均在 2026-10-25 逐个打开核对过。

## 失效信号

目录结构调整后请直接改这张表；`catalog/` 目录被建起来时，技能一行要改写。
