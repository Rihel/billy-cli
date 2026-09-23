---
name: develop-ai-agent
description: >-
  在 Billy 工程（billy-cli）中开发 / 扩展 AI 能力（`apps/server/src/modules/ai`）：新增 agent、
  新增工具（业务工具 bean）、新增 core bean（`asTools()` 的运行时能力：规划 / 子 agent）、
  新增技能（SkillLoader catalog）、写提示词（eta 模板）、改会话 / 运行 / 时间线落库与 SSE 流式协议、
  动态子 agent、上下文裁剪与压缩、崩溃恢复与看门狗。触发词：AI、agent、agent key、工具、
  tool、core bean、asTools、planner、子 agent、sub-agent、技能、skill、提示词、prompt、eta、
  会话、conversation、run、运行、时间线、timeline、流式、SSE、AI SDK、Mastra、token 消耗、
  上下文压缩、恢复、看门狗。
---

# 开发 AI 能力（`modules/ai`）

前置：先加载必读 skill `billy-dev-foundation`；数据结构改动配合 `define-data-structure` /
`database`，接口质量自查看 `develop-backend-api`，写页面看 `develop-frontend-page`。
**权威设计文档**：`docs/design/ai-agent.md`（改 AI 前先读它，改完同步它）。

## 0. 四条硬规则（违反即返工）

1. **不加物理外键**（全工程唯一硬规则，`runs` 的自引用更不行）；
2. **`runs` / `timelines` 永不删除**（审计证据）——只有**会话**能删，且只能软删；
3. **工具入参出参、子 agent 的动态提示词与任务、摘要正文一律全量入库**，不裁剪；
4. **术语固定**：轮（turn）= 一次问答 = 一个**根 run**；步（step）= 一次模型调用；
   「回合」已弃用；对外标识统一叫 **agent key / tool key**（不叫 agentId）。

## 1. 模块地图

| 目录 | 放什么 | 加东西时改哪 |
| --- | --- | --- |
| `core/` | 机制 + **core bean**：`ai.config` / `ai.types` / `ai.registry` / `ai.mastra` / `planner.core` / `subagent.core` | 加 core bean：写类 + 注册 `AGENT_CORES` |
| `agents/` | **顶层** agent 声明（前端能选的就这些）+ `index.ts` 唯一登记处 | 加 agent：一个文件 + `AGENT_SPECS` 一行 + 一个 eta 模板 |
| `tools/` | **业务**工具 bean（绑单一业务模块）+ `tool-keys` + `ToolBuilder` | 加工具：一个 bean + `AGENT_TOOLS` 一行 + `TOOL_KEYS` 一个 key |
| `prompts/` | 提示词引擎 + `templates/*.eta` + `partials/` | 模板变量由装配层注入（工具清单来自 `ToolBuilder.describe`） |
| `skills/` | `SkillLoader` + `catalog/<name>/SKILL.md`（+ `references/`） | 加技能：一个目录 + 在 agent 声明的 `skills` 里授权 |
| `runtime/` | 会话 / 运行 / 时间线仓储与服务、上下文、流记录、子 agent 执行器、看门狗 | 改行为先看 `runtime.md` |

细节：会话运行链、上下文策略、SSE 协议与恢复 → [references/runtime.md](./references/runtime.md)；
扩展点（加 agent / 工具 / core bean / 技能 / 子 agent）→ [references/extension.md](./references/extension.md)。

## 2. 装配方向（不许反）

```
AGENT_TOOLS(业务工具 bean) ┐
                           ├─→ ToolBuilder（拍平成一张 key→工具表，重复 key 启动即失败）
AGENT_CORES(core bean) ────┘        ↑ 只被装配层与编排层消费
core bean ──→ 仓储 / AgentRunner / 配置      （**不注入 ToolBuilder**，否则成环）
编排层（AgentChatService）──→ 把"子 agent 能用什么工具"经 requestContext 信封传进工具
```

`ai.module.ts` 是唯一装配处：新增工具 / core bean 都要在那里登记一行（显式的代价换来一目了然）。

## 3. 验证与质量门

```bash
pnpm --filter @app/server test test/ai-plan-subagents.test.ts   # 规划 / 子 agent / 审计
pnpm --filter @app/server test                                  # 含真实 Redis 的流式 e2e
pnpm typecheck && pnpm test && pnpm check:ui                    # 全仓门
```

- **离线 mock 模型**在 `test/helpers/mock-model-server.ts`（`[plan]` / `[delegate]` / `[slow]` 标记），
  不需要任何外部密钥；新增能力优先给它加一个标记 + 一条端到端断言；
- 改契约（`@repo/shared`）后**必须** `pnpm build:pkgs`，否则 `@repo/*` 仍解析 dist；
- 迁移：`pnpm --filter @app/server db:generate <名字>` → 迁移文件首行改 `import type`，
  并**人工检查部分索引（partial unique）的条件变化**（TypeORM 检测不到）。
