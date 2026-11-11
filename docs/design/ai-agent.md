# AI 能力设计方案（ai-elements 组件库 + Mastra Agent 运行时）

> **目标**：让这套脚手架「能开发 AI 应用」——
> 前端有 AI 对话组件库（ai-elements 全量），后端有**多 agent** 开发能力（Mastra），
> 会话 / 推理 / 消息**落库**、有短期与长期记忆、运行状态**可持久化并能在重启后恢复**，
> 前端能流式看到 AI 跑的**每个细节**且状态实时更新。
>
> **状态**：本方案分两批写。**第 1～3 章已定稿**（含源码级证据）；第 4 章等另两路调研
> （记忆与落库、AI SDK v6 全细节流式）回来后补齐。方案评审通过前**不写运行时代码**。

## 0. 需求（本轮明确，以此为准）

| 编号 | 需求 | 关键含义 |
| --- | --- | --- |
| A | 集成 ai-elements 组件库 | **已全量落地**：上游 sitemap 的 **48 个条目 100%** 进 `@repo/ui/src/components/ai-elements/`（9334 行），子路径引入、不进 barrel；`ai` 锁 `^6.0.289` 与后端同版本 |
| B | server 集成 Mastra agent 开发能力 | **多 agent**：一个 agent 一个文件、注册表登记；工具 bean 化；技能可加载 |
| C | 落库（**记忆本轮不做**） | 会话信息、**推理过程**、消息列表入库；长期 / 工作记忆 / 向量召回推迟，上下文自己从时间线拼 |
| D | 运行状态机 + 重启恢复 | 运行时状态持久化；**服务重启后恢复在跑的会话** |

**术语表（本方案只用这几个词，别的都是它们的组合）**

| 词 | 大白话 |
| --- | --- |
| 会话 | 一个对话窗口（用户和某个 agent 的一串问答） |
| 轮（turn） | 一次问答：用户发一句 → agent 答完 |
| 步（step） | 一轮里的一次模型调用（含它引发的工具往返） |
| 运行（run） | 一次问答在我们库里的记录（状态、消耗、起止时间） |
| 时间线 | 会话里按顺序发生的事：用户消息、模型回答、推理、工具调用与结果、状态变化 |
| **运行中进度** | 这一次运行「正在跑」的临时信息（第几步、当前在干什么、产出到哪、心跳），**放 Redis、跑完删** |
| 最终结果 | 这一次运行跑完后的结论（成功/失败、消耗、耗时），**放 Postgres、长期保留** |
| agent key / tool key | agent 和工具的稳定标识（字符串），前后端与数据库都用它 |
| **core bean** | 跨业务的**运行时能力**单元，用 `asTools()` 把能力交给 agent（规划、子 agent 创建）；与"业务工具 bean"相对 |
| **子 agent** | 主 agent 在跑的过程中**现场创建**的临时 agent（提示词由主 agent 写、工具面 = 全部 − 委派类），不是注册表成员（§3.14） |
| 压缩 | 把早期对话交给模型写成一段摘要，后续改用摘要（原文仍保留） |
| 裁剪 | 直接把最早的一部分对话丢掉（不生成摘要） |
| **F** | **core bean + 动态子 agent** | core bean 用 `asTools()` 交出能力（planner 即其一）；**子 agent 由主 agent 调用工具创建**，system prompt 由主 agent 现写，工具面 = 全部 − 委派类，**明细全部入库**（详见 §3.14） |
| E | 前端完美流式 | AI 跑的每个细节（文本 / 推理 / 工具 / 步骤 / 来源）实时可见，状态同步更新 |

## 1. 已落地的结构层（代码已在仓库、可验证）

### 1.1 目录与职责（`apps/server/src/modules/ai/`）

```
ai/
  ai.module.ts        Nest 装配（配置 → 工具 bean → ToolBuilder → SkillLoader → 注册表 → Mastra）
  ai.controller.ts    只读路由：/agent/status、/agent/list（会话路由刻意未写，见 §3）
  core/               机制层：ai.config / ai.types / ai.registry / ai.mastra / ai.service / ai.errors
                      + **core bean**（planner.core / subagent.core：跨业务的运行时能力，asTools()）
  agents/             每个 agent 一个声明 + index.ts 唯一登记处（顶层 agent：assistant）
  tools/              tool-keys 常量 + 业务工具（一个工具一个 bean）+ ToolBuilder（统一管理两个来源）
  prompts/            提示词引擎 + templates/*.eta（含 partials）
  skills/             SkillLoader + catalog/<name>/SKILL.md（+ references/）
```

### 1.2 工具：一个工具一个 bean + `ToolBuilder` 统一管理

> **⚠️ 本节已被 `docs/design/ai-agent-tool-engine.md` 取代（2026-10-01）**：工具不再是"一个 bean 自己
> `createTool`"，而是**一份声明（`ToolSpec`）+ 注册机（`ToolRegistry`）+ 网关插件链（`ToolGateway`）**；
> 配置（开关 / 作用域 / 限额 / 秘钥）入库并可后台修改；Mastra 的词汇收进 `ai/mastra/**` 适配器。
> 下面这段保留作**历史与背景**（"为什么一个工具一个 bean"的论证仍然成立）。
>
> **机制再演进（2026-10-01）**：工具 DSL 现在是**工具组 + 方法即工具** —— 一个工具组 = 一个
> `@Injectable()` 类（类上可选 `@ToolGroup`），**组内一个 `@ToolDecl` 方法就是一个工具**；
> `AGENT_TOOL_GROUPS` 汇总的是**工具组实例**（一个组 1..n 个工具）；`AgentCore` / `asTools()` 已取消。
> 见 `docs/design/ai-agent-tool-engine.md` §5.2。

- 业务工具（若接入）各自 `@Injectable()`，构造器注入对应业务 service，在构造期用 `createTool` 绑定
  `execute`；本脚手架默认不绑定业务工具，AI 模块与业务模块解耦；
- 模块里用 `AGENT_TOOLS` token 汇总成数组（Nest 多 provider），`ToolBuilder` 负责：
  按 id 取用（`build`）、给提示词提供元数据（`describe`）、**装配期校验**（未知 id 直接启动失败）；
- agent 声明里只写**工具 key**（来自 `tool-keys.ts` 常量），能力边界 = 工具可见性；
  「key」是稳定对外标识（与 agent key 同一套词汇），Mastra 的 `createTool({ id })` 是它的接口字段，装配处做一次映射；
- **两个来源**（`ToolBuilder` 汇总成一张表，重复 key 启动即失败）：业务工具 bean（`ai/tools/*.tool.ts`，
  绑定单一业务模块）+ **core bean**（`ai/core/*.core.ts`，`asTools()` 交出跨业务的运行时能力：规划、子 agent）。
  子 agent **不走** `subAgents` 静态声明，而是 core bean 提供的工具在运行期创建（§3.14）。

### 1.3 提示词：引擎 + eta 模板（**所有提示词只走引擎**）

- 标签统一 `{{ }}`（执行）/ `{{= }}`（插值）/ `{{~ }}`（include）/ `{{ /* */ }}`（注释）；
  不用 eta 默认的 `<% %>`：提示词是 Markdown，正文里大量 `<` `>`（`<xxxId>`、HTML 示例）容易撞标签；
- **提示词的"可用工具"段落由 agent 实际授权的工具渲染**（`ToolBuilder.describe`），
  提示词与权限不会各写一份、互相漂移；公共段落走 `partials/`（改一次全 agent 生效）；
- 引擎配置：`autoEscape: false`（提示词是纯文本，HTML 转义会把引号变 `&#34;`）、`cache: true`；
  渲染结果**只清首尾空行**；
- `dedent` 已装，但**只用于代码里手写的多行字符串**（如错误信息）：实测
  `dedent('- 第一行\n  第二行续')` 会把列表续行的缩进吃掉，而那段缩进在 Markdown 里有意义。

### 1.4 技能：`SkillLoader` 发现 / 校验 + Mastra 加载

> 2026-11-10 起多了一层**技能库**（后台在线编辑 / 从 skills.sh、GitHub 链接导入 / 启停，DB 是事实源、落盘给 Mastra，
> `skills: ['*']` 运行期展开不用重启）：见 `docs/design/ai-skill-library.md`。

技能内容用 **Agent Skills 标准格式**（`SKILL.md` 的 YAML frontmatter + Markdown 正文 + `references/`），
与仓库根 `.agents/skills/` 同构。**加载分两段，各管一段**：

| 谁 | 管什么 |
| --- | --- |
| `SkillLoader`（我们） | **发现**（扫目录）、**校验**（`validateSkillContent`，启动期）、**授权**（按名字给出技能目录绝对路径） |
| Mastra（`Agent({ skills: [目录路径] })` → `LocalSkillSource` / `WorkspaceSkills`） | 清单（名字 + 描述）注入提示词；正文与 `references/` 由 `skill` / `skill_search` / `skill_read` 工具**按需读盘** |

- **不把正文读进内存**：#技能可能几十个、参考文件上百个，内联（`createSkill`）等于启动全读；
  路径形态下 Mastra 按需读，技能改了也不必重启（带冷却的自刷新）。
- 目录来源（按优先级）：① `core/skills/catalog/`（随部署打包，**校验不过 = 启动失败**）；
  ② `AgentConfig.skillsDirs`（默认 `~/.agents/skills`，`AGENT_SKILLS_DIRS` 逗号分隔多个；
  **坏一个只跳过并记错误日志**——别人的技能库不该绑架启动）。重名时前面的目录赢。
- agent 按名字授权（`skills: ['<skill-name>']`；`skills: [ALL_SKILLS]` = 全部已加载技能，
  **装配期展开成真实名字**，于是 `/agent/list` 与 `request_snapshot.skillKeys` 里是具体技能名）。未知名字装配期报错。
- 早先不直接用 Mastra 的目录能力，理由是"无法启动期校验、也无法把清单暴露给接口"——
  现在这两件事都由 `SkillLoader` 自己做了（校验在启动期、清单进 `/agent/list`），
  所以内容侧重新交回 Mastra，避免我们自己实现一套读盘 / 缓存 / 参考文件服务。

**实测（2026-10-27，`~/.agents/skills` 24 个技能）**：加载 23 个（`xilo-opus-video` 的 description
超 1024 字符被跳过）；`/agent/list` 返回这 23 个名字；让模型"列一下你能用的技能"能答出
`ant-design / impeccable / minimalist-ui / shadcn / humanizer-zh`。
代价是**每轮多约 11k token**（该轮 inputTokens 15690，我们自己的估算 4004 只覆盖到提示词本身，
不含 Mastra 后注入的技能清单）——技能描述很长时这笔开销是真的，要省就瘦身 description 或收窄授权名单。

### 1.5 已跑通的验证（实测）

- `pnpm --filter @app/server exec tsc --noEmit` 通过；`pnpm check:inject` 通过；
- 实跑（tsx 直跑，不依赖数据库与模型密钥）：两个 agent 的提示词渲染正确（工具清单由授权生成、
  技能授权正确、缩进保留）；`SkillLoader` 加载出技能正文（含 `references/` 下的参考文件），
  未知技能名按预期抛错。

## 2. 调研结论：Mastra 的运行时与可恢复性（源码级证据）

> 证据来源：`@mastra/core@1.69.0` 本地 tarball 的 `.d.ts` / 编译产物 + mastra.ai 官方文档。
> 这一章是 §3 设计的地基，也是**推翻若干想当然假设**的地方。

### 2.1 结论摘要

| 能力 | 结论 | 关键前提 |
| --- | --- | --- |
| 服务重启后**续跑在跑的会话** | **能做**，但唯一官方路径是 **durable agents** | 持久化 storage + `running` checkpoint 落库 + **工具幂等** |
| **断线重连**拿回剩余输出、不重跑已产出 | **能做**：`observe(runId, { offset })` 从缓存重放 | 进程仍活着 + 共享 cache |
| 进程**崩溃后不重跑**地续接 | **做不到** | `recover()` 会重发 LLM 调用（官方明文） |
| `/chat/:agentId/:runId/stream` 式续传端点 | **不存在** | 官方 server routes 全表无此路由 |
| `@mastra/ai-sdk` 支持 `reconnectToStream` | **不支持** | 仅 POST `/chat/:agentId`，runId 走 body |
| 普通 `agent.stream()` 跨进程恢复 | **做不到** | 官方："can't resume after its server process exits" |

### 2.2 最重要的语义鸿沟：断线重连 ≠ 崩溃恢复

- **断线重连（进程活着）**：`durableAgent.observe(runId, { offset, idleTimeoutMs, isAlive })`
  从 append-only 缓存重放已产出事件，**不重跑**。这是"刷新页面还能看到刚才那段输出"的正解。
- **崩溃恢复（进程死了）**：只能 `recover()`，而官方 Warning 写明
  **"Recovery re-runs the agentic loop from the last snapshot, which re-issues LLM calls (real cost)
  and re-executes tool calls."** → 恢复不是免费的，它**真的会再花一次模型钱**，并把工具再跑一遍。

**所以「服务重启恢复在跑的会话」必须拆成两档来决策**（见 §3.3），不能一句"支持恢复"糊过去。

### 2.3 run 状态存在哪儿

- **没有** `mastra_agent_runs` 表；`storage/domains/agents` 是 **agent 配置的版本管理**，不存 run；
- 真正的 run 快照在 **`mastra_workflow_snapshot`**（durable agent 的底座就是 workflow），
  操作入口是 `storage/domains/workflows` 的 `persistWorkflowSnapshot` / `loadWorkflowSnapshot` /
  `listWorkflowRuns`（支持按 `status` 过滤）；
- `WorkflowRunStatus` 取值：`running | success | failed | tripwire | suspended | waiting | pending |
  canceled | bailed | paused | skipped`；
- 快照里的 `DurableAgenticWorkflowInput` 含 `runId / agentId / messageListState（序列化的消息与 part）
  / toolsMetadata` → **足够知道跑到哪一步、已产出哪些 part**；
- 但**非序列化态（模型实例、RunRegistry 等）只在进程内存**（TTLCache），崩溃即丢、由 `recover()` 重建。
- ⚠️ 硬约束：`listActiveRuns()` / `recover()` 要求 agent 注册在**带持久化 storage 的 `Mastra` 实例**上，
  否则抛 `DURABLE_AGENT_LIST_ACTIVE_RUNS_NO_STORAGE`。**但不需要 Mastra 的 HTTP server。**
- ⚠️ 默认策略只持久化 `pending|paused|suspended`，**`running` 不落库** —— 要恢复必须显式开启
  （`recovery: { durableAgents: 'auto' }` 或自定义 `shouldPersistSnapshot` 含 `running`）。

### 2.4 多实例部署的要求

默认 `EventEmitterPubSub` + `InMemoryServerCache` 是**单进程**的（官方：不跨进程、不持久）。
多副本要换后端：cache 用 `@mastra/redis` 的 `RedisServerCache`，pubsub 用
`@mastra/redis-streams` 的 `RedisStreamsPubSub`。1.69.0 代码里 `RedisStreamsPubSub implements LeaseProvider`
（`SET NX PX` 原子租约），多副本恢复会被串行化；官方文档却写"不提供分布式锁"，**二者冲突，
以代码为准但仍在方案里标注存疑**。

### 2.5 不用 Mastra 自带 HTTP server 时的可用性边界

（本工程自建 NestJS 边界，这条决定"哪些能力拿不到"）

| 能力 | 能否用 |
| --- | --- |
| durable agent 全套方法（`stream` / `observe` / `recover` / `listActiveRuns` / `abort` / `resume`） | ✅ |
| `mastra.recoverAllDurableAgents()`（官方明说"可以直接调"） | ✅（我们在 boot hook 里调） |
| `handleChatStream()` / `toAISdkStream()`（返回流，自己包 Response） | ✅ |
| 快照存储层、`CachingPubSub`、`createReplayStream`、`MastraServerCache` | ✅ |
| `chatRoute()` / `networkRoute()` / `workflowRoute()` 与所有 `/api/agents/...` 端点 | ❌（依赖它的 server） |
| `recovery.durableAgents: 'auto'` 的**自动**执行部分 | ❌（由它的 deployer 触发；我们用 boot hook 等价替代） |

## 3. 运行时设计

### 3.0.0 先把「durable（可恢复执行）」说清楚（**2026-10-07 补，因为这块知识原先散在 §2.2 / §3.3 / §3.13 三处**）

**一句话**：durable = **这一轮问答跑到一半，服务崩了/重启了，回来能接着往下跑**。

**它解决什么**：一轮问答可能要走很多步（每次模型调用算一步，中间还会执行工具）。举例：用户让助手
"整理一份周报"，要跑 5 步、耗时一分钟。跑到第 3 步时服务被重启：

| | 结果 |
| --- | --- |
| **没有 durable** | 这一轮断在原地，用户看到失败、前面花的钱白花，得重发一次从头再来 |
| **有 durable** | 服务起来后知道"跑到第 3 步了、前两步产出了什么"，**接着跑完**，用户几乎无感 |

**它怎么做到**：**每走完一步，就把"这一轮目前的状态"存一份**到 `runs.snapshot`（JSONB 列，
内容是 Mastra 的工作流快照：`runId` / `agentId` / `messageListState`（序列化的消息与 part）/
`toolsMetadata`）。启动时 `AgentRecoveryService` 抢一把 Redis 租约（多副本只有一个动手），
调 `mastra.recoverAllDurableAgents()` 把"没跑完的"接上。

**代价（当初就写明了，不是新发现）**：恢复是**从上一个快照重放** ——
会**重发模型调用、重跑工具，真花钱**。所以配套要求：**工具必须幂等**、恢复次数有上限
（`recovery_count`）、运行超时 + 看门狗兜底。

**怎么开关**：`AGENT_DURABLE_ENABLED`（默认 `true`）。关掉就没有"崩溃续跑"，但图片等多模态
不受影响（见 §3.16.2.1 那次事故）。

**⚠️ 快照能落库的前提：`runs.engine_run_id` 必须是引擎那个 runId**。快照落库是
`UPDATE runs SET snapshot ... WHERE engine_run_id = :runId` —— id 对不上就**丢掉快照**并记
`ai.storage.snapshot_orphan_skipped`。2026-10-07 之前这里一直是空的（没人写 `engine_run_id`），
所以 **"崩溃续跑"这条线从未真正生效**：库里 60 条运行只有 13 条（早期手工造的）带快照。
现在由**我们生成**（`eng_<我们的 runId>`）、起跑时回写，并同时交给 Mastra
（`agent.stream(..., { runId })`），两边用同一个 id。

**两次踩坑都跟它有关**（都记在案，别再犯）：
1. **多模态被压平**：`@mastra/core@1.69.0` 在 durable 下把 `content` 数组压平成纯字符串，
   图片静默丢失（§3.16.2.1）—— 症状像"模型不支持读图"，实为框架 bug，升级 `1.75.0` 修复；
2. **实验与生产配置不一致**：排查时我的实验一律用 `new Agent()`（默认**非** durable），
   而生产是 `createMastraAgent({ durable: true })`，于是**完全复现不出来**。
   **教训：A/B 只能改一个变量，且实验必须与生产同配置。**

### 3.0 已拍板的三条（本轮确定，作为后续设计前提）

| 决策 | 结论 | 对设计的影响 |
| --- | --- | --- |
| 崩溃恢复 | **必须做**（默认开启） | 必须走 durable agent 路线（官方唯一路径），并接受"恢复会重放/重发 LLM 调用"的语义 |
| zod 版本 | **全仓升到 `^4.6.5`** | 已执行：4 个 package.json + lock 更新，lock 里 zod 4 只剩一个版本 |
| 数据表 | **不用 Mastra 官方表，自己设计** | 自己实现 **Mastra storage adapter**，把 memory / workflow 快照落进**我们的表**；官方 Memory 与 durable agent 通过该 adapter 读写我们的表 |

**「自己设计表」的具体含义（重要，避免误解）**：

- 表结构、字段、索引、迁移**由我们设计**（TypeORM 实体 + 迁移，随工程走，可评审、可演进）；
- 前端与业务查询**只走我们自己的 repository / 接口**，不直接读 Mastra 的表结构；
- Mastra 的 `Memory`（短期 / 工作记忆 / 长期）与 durable agent 恢复能力**继续使用** ——
  它们通过我们实现的 storage adapter 读写；
- 我们的 adapter 只需实现**两个 domain**（实测抽象方法数）：
  `memory` 10 个方法（thread 的增删改查 + 消息的增删改查 + 列表）
  + `workflows` 9 个方法（快照持久化 / 读取 / 运行列表 / 查删）；
- **一处必须说清的边界**：workflow 快照的内容是 Mastra 的内部状态（我们存 JSONB、不解析、不做业务查询），
  我们掌控的是**容器表结构**与**接口读写路径**；这带来一个长期成本 ——
  **升级 Mastra 时要跟着它的 storage 接口演进补方法**（写成一个固定的适配层，不是散落各处）。

### 3.1 两层状态要分清：我们的业务状态 ⟂ Mastra 的运行快照

必须分清，否则会写出两套互相打架的状态：

| | 业务侧（我们） | 运行时侧（Mastra） |
| --- | --- | --- |
| 存什么 | 会话（谁、什么标题、用哪个 agent、是否归档）、消息与推理过程、**业务状态**（排队 / 运行 / 已中断 / 已恢复 / 失败 / 完成） | run 快照（跑到第几步、已产出哪些 part、suspend 点）——内部状态，我们不解析 |
| 存哪 | **同样是我们设计的表**（见 §3.0 与 §4.4：经自建 storage adapter 落库，Mastra 不建任何表） | 同上 |
| 谁改 | 我们的 repository（业务规则、权限、审计） | Mastra 经 adapter 读写（恢复 / 重放语义由它决定） |
| 关系 | 业务侧记录 `runId` 作为**外键引用**，不复制它的内部状态 | 运行时侧不关心业务语义 |

**原则**：这两层的分界不是"谁的表"，而是**谁定义语义**——
业务语义（会话 / 权限 / 状态展示 / 审计）在我们这边，run 的恢复语义在 Mastra 那边；
两者共用一套表，但通过**各自的访问路径**（我们的 repository / 它的 storage adapter）读写，
边界清楚地写在适配层里。

### 3.2 会话模型

- `thread` = 会话（一个对话窗口），`resource` = 归属主体（**用登录用户 id**，天然多租户隔离）；
- 消息与推理：由 Mastra Memory 落库（`mastra_messages` 等表），**同时**在业务侧保留
  会话元信息（标题、agent、最后活动时间、状态）——具体字段与两条记录的同步方式见 §4.1（待补）；
- `run` = 一次"用户发一条 → agent 跑完"的执行，业务侧存 `runId` + 状态 + 起止时间。

### 3.3 恢复策略：三档，各自明确代价（**需要你拍板**）

| 档 | 场景 | 手段 | 代价 |
| --- | --- | --- | --- |
| ① 断线重连 | 用户刷新页面 / 网络抖动，**进程还活着** | `observe(runId, { offset, idleTimeoutMs })` 重放缓存事件 | 无重跑；需要共享 cache（Redis）才能跨实例 |
| ② 崩溃恢复 | 服务重启 / 进程被杀，run 未完成 | boot 时 `recoverAllDurableAgents()`；**工具必须幂等** | **重发 LLM 调用（真花钱）+ 重跑工具**；官方明文 |
| ③ 不恢复 | 同上，但不想付 ② 的代价 | 启动时把 `running` 且进程已死的 run 标记为 `interrupted`，前端提示"该轮已中断，可重试" | 用户需手动重发；但成本可控、语义诚实 |

建议：**①②③ 都实现，但用配置开关决定 ② 是否开启**（默认开启 ②，因为这是需求 D 的核心；
③ 作为兜底 —— 恢复失败或超时的 run 落到 ③）。

### 3.4 工具幂等（② 的硬前提）

崩溃恢复会**重跑工具**。当前业务写工具（若接入）会在重跑时**再写一条数据** —— 这是必须解决的问题：
- 幂等键：`runId + toolCallId`（Mastra 的历史消息里带 toolCallId；重放时同一 toolCallId 只生效一次）；
- 位置：业务侧一张轻量去重表（或复用 `RedisStore` 的 `setJson + TTL`）；
- 只读工具（`list-xxx` / `get-xxx`）天然幂等，无需处理。

### 3.5 前端全细节流式

- 传输：AI SDK v6 的 UI Message Stream（`x-vercel-ai-ui-message-stream`），服务端用
  `toAISdkStream({ from: 'agent', version: 'v6' })` + `handleChatStream`；
- **每个细节**都要流到前端：文本、推理、工具调用（输入流 / 输入可用 / 输出可用 / 出错 / 审批）、
  步骤边界、来源引用（完整 part/chunk 清单与 AI Elements 组件的 props 映射见 §4.2，待补）；
- **业务状态**（排队 / 运行 / 已中断 / 已恢复 / 失败 / 完成）用自定义 `data-*` part 或
  `messageMetadata` 注入同一条流，前端 `useChat` 的 `onData` 消费 → 状态与内容**同源、不会错位**；
- 断线：前端带 `runId + offset` 重新订阅（走 §3.3 ①），拿回缺失片段而不是重来。

### 3.6 多实例

- cache：`@mastra/redis` 的 `RedisServerCache`（事件重放要跨实例）；
- pubsub：`@mastra/redis-streams` 的 `RedisStreamsPubSub`（跨实例事件 + abort + 恢复租约）；
- 新增依赖要在方案里列清（`@mastra/redis`、`@mastra/redis-streams`），并确认与既有 `RedisStore` 的关系。

### 3.7 异常与状态处理（失败是一等状态，不能只写日志）

**状态枚举**（`RunStatus` 字典，7 个，不搞状态爆炸）：
`pending`（排队）/ `running`（运行中）/ `suspended`（等待用户回答）/ `succeeded` / `failed` /
`interrupted` / `canceled`。`suspended` 不设 `finished_at`，也不被看门狗判超时；
用户回答、停止或删除会话才离开。
崩溃恢复期间状态**回到 `running`**，用 `recovery_count` + 时间线上一条 `status` 事件如实标注"已恢复重跑"，
不为它单开一个状态。

**最重要的区分：流开始前失败 vs 流中途失败**

| 时机 | 用户看到什么 | 处置 |
| --- | --- | --- |
| **首字节前**失败 | 什么都还没看到 | 可安全重试（SDK 内建重试）甚至换模型；仍失败 → `failed`，用户看到错误提示 |
| **流中途**失败 | 已经看到部分文本/工具调用 | **禁止静默重跑**（内容重复、工具重复执行）→ `failed`，已产出内容**保留在时间线**，前端提示"本轮已中断，可重试（会新建一轮）" |

**分场景规则（每一行都要落到代码，不是口号）**

| 场景 | run 状态 | 动作与位置 |
| --- | --- | --- |
| 我们侧校验失败（未配置 / agent 不存在 / 会话不存在或无权 / 参数错） | **不创建 run** | 边界错误码经响应信封返回，不留垃圾记录 |
| 本地限流（4002） | **不创建 run** | 守卫层拦截 |
| 上游限流（模型 429） | 首字节前 → `failed`；中途 → `failed` | `error_stage=model`；前端提示稍后重试 |
| 模型鉴权失败（401，属**部署问题**） | `failed` | `error_stage=model` + **走既有告警钩子**（`ERROR_ALERT_HOOK`），不能只躺表里 |
| 模型上游 5xx / 网络抖动 | 先由 SDK `maxRetries` 重试，仍失败 → `failed` | `error_stage=model`，`error_detail` 存脱敏原文 |
| 上下文超长 | `failed` | 独立错误码（前端提示开新会话 / 精简上下文） |
| **工具执行失败** | **run 未必失败** | 工具错误回给模型（它可以改参数重试）→ 时间线落 `kind=error`（`state=output-error`）；模型最终放弃才 `failed`，`error_stage=tool` |
| **工具挂起（`ask-user-questions`）** | `suspended` | 流收尾但**不 finish**：落 `tool-suspended` 时间线 + 保存 engine runId / 用量；同一会话的部分唯一索引把 `suspended` 也算作"进行中"，防止另开一轮。用户回答走 `POST /agent/chat/resume`；停止走同一 stop 端点（直接 `canceled`） |
| 用户点停止 | `canceled` | stop 端点：落 partial → abort → **仅当 activeStreamId 未变才清空**（§5.3） |
| 用户删除会话 | 先停 run 再软删 | 有 `pending` / `running` / `suspended` 的 run → 先 `canceled`，再软删会话；**运行记录与时间线一律保留**（§4.5） |
| **客户端断线 / 刷新页面** | **继续 `running`（不取消）** | 这是刻意设计：服务端不因客户端断开而停；内容继续落库，用户回来靠续传或历史看到完整结果（所以**禁止在 unmount 里 stop**） |
| 进程崩溃 / 重启 | 启动期恢复 | `heartbeat_at` 过期 → `recover()`（**最多 1 次**，`recovery_count+1`）；恢复失败或超次数 → `interrupted`，前端可手动重试 |
| 运行卡死 / 总时长超限 | `failed`（timeout） | **看门狗**：总时长或心跳超限 → abort + 标超时；否则会永久停在 `running`。多副本下用**条件 UPDATE 抢执行权**（§3.10），不用分布式锁 |
| 同一会话并发的第二次请求 | 拒绝，不创建 | 部分唯一索引挡住 → 错误码 3306（会话正忙） |

**错误落在三处，各司其职**

1. `runs`：`error_code` / `error_stage` / `error_message` / `error_detail`（上游原文**全量保留**，仅做密钥掩码，不截断）；
2. `timelines`：落一行 `kind='error'`（带 `started_at` / `finished_at` / `duration_ms`）——
   让前端时间线能精确指出"第几步、哪个工具出的错"；
3. 日志与告警：`AppLogger` 记 `agent.run.failed`（含 runId / conversationId / stage）；
   部署级错误（模型鉴权、恢复失败）经既有 `ERROR_ALERT_HOOK` 告警。

**脱敏是硬要求，但脱敏 ≠ 裁剪**：上游错误常带 `sk-*` 或整段 prompt。落库前统一过 `redactError()`
—— 把密钥形态替换成掩码（`sk-***`），**文本长度不裁剪**，与日志的 redact 同一口径。
（工具入参出参另有规定：见 §4.6「保真原则」—— 一个字都不裁。）

**错误码（3xxx 段续号，新增）**

| 码 | 含义 | HTTP |
| --- | --- | --- |
| 3301 | AI 能力未配置（已有） | 503 |
| 3302 | AI 回复失败（已有，通用兜底） | 502 |
| 3303 | 指定的 agent 不存在（已有） | 404 |
| 3304 | 会话不存在或无权访问（**不区分"不存在"与"不是你的"**，避免探测他人会话） | 404 |
| 3305 | 运行记录不存在 | 404 |
| 3306 | 该会话已有进行中的一轮（并发拒绝） | 409 |
| 3307 | 上下文超长 | 400 |
| 3308 | 模型鉴权失败（部署配置问题） | 502 |
| 3309 | 上游模型限流 | 429 |
| 3310 | 运行超时 | 504 |

**重试语义（必须与"恢复"分开）**：用户点"重试"= **新建一个 run**（旧 run 的失败记录保留）；
崩溃恢复 = 同一 run 的 `recover()`（会重发模型调用、重跑工具，故工具必须幂等，§3.4）。
两者不可混用，否则要么丢审计、要么重复扣费。


### 3.7.1 工具挂起与续跑（`ask-user-questions`，Mastra 原生 suspend/resume）

**为什么走原生**：问题卡不是普通工具结果，而是"这一轮暂停、等用户输入"；用 Mastra 的
`Tool.suspend()` + `agent.resumeStream()` 才能保持同一个 engine run、同一段消息历史，
不用伪造一条用户消息。

**服务端链路**

1. `ask-user-questions` 是**原生 Mastra 工具**（`mastra/ask-user-questions.tool.ts`，只给主 agent）：
   `suspendSchema={questions}`、`resumeSchema={answers}`；
2. 工具 `execute` 在无 `resumeData` 时调用 `context.agent.suspend({questions})`；
   resume 时把答案排成模型可读文本返回；
3. `chatStream` 看到 `data-tool-call-suspended` 后**主动停止读流**，走 `runs.suspend()`：
   状态 `suspended`、保存用量 / 步数、释放 active stream，但**不写 `finished_at`**；
4. 前端把答案 POST 到 `POST /agent/chat/resume`；`resumeChat` 用**应用 runId** 找回
   run / conversation，调 `agent.resumeStream(..., { runId: engineRunId, toolCallId })`；
5. Mastra 只恢复工具、不会自动再跑一轮模型；`resumeChat` 再起一段新 engine run
   （复用同一 memory thread + 新用户消息），把续跑推到最终文本，并把新 engineRunId
   回写到 `runs.engine_run_id`。

**两个实现要点（都是踩过的坑）**

- **一个 `runs.snapshot` 存多个 workflow 快照**：durable agent 同时产生
  `durable-agentic-loop`（外层）和 `durable-agentic-execution`（内层）。只存最后一个，
  resume 时内层 `typedInput` 会丢（`Cannot destructure property 'agentId'`）。
  因此 `runs.snapshot` 存 `{ [workflowName]: snapshot }`，按名读取；
- **必须有 memory thread**：Mastra 1.78 的 resume 在无 thread 时只恢复工具，不发起下一次
  模型调用（实测 mock 请求数停在 1）。`chatStream` 按会话建 thread，
  `agent.stream` / `resumeStream` 都带 `memory: { thread: conversationId, resource: userId }`，
  并 `savePerStep: true`。当前 memory 用 `InMemoryStore`（进程内），**重启续跑**仍需换成
  落库的 memory 存储域或启动时从 `timelines` 回灌 —— 这是已知缺口。

**时间线 / 历史**

- 挂起落 `kind='tool-suspended'`，payload 带 `runId`（应用 runId）、`engineRunId`、
  `toolCallId`、`toolName`、`suspendPayload`、`resumeSchema`；
- 续跑成功补一条 `tool-result`（`toolKey='ask-user-questions'`），出参是结构化的
  `{ text, answers }`：`text` 给模型读（`toModelOutput` 只交给模型这一份），`answers`
  给前端按题还原；历史据此把问题卡标成已回答，并**留在它自己的位置**改成只读的问答记录
  （问题 + 答案，逐题翻看），不再让用户重复回答，也不把整组问答挪到结果行；
- 问题卡是**逐题**交互：一次只显示一道题，答完当前题才能「下一题」，可用
  「上一题 / 下一题」来回切换；最后一题「提交回答」，一次交整组 `answers`
  （resume 入参是整组，不是单题）；
- **取消整组回答**（2026-11-11 补）：卡片上有「取消回答」，点击后前端提交
  `{ cancelled: true }`（不带 answers）续跑。Mastra 的 `suspend()` 没有
  `declineToolCall()` 那种独立拒绝入口（官方只对 `requireApproval` 提供）；官方做法就是
  `resumeStream(resumeData)`，因此这里把取消编码进 `resumeSchema`，工具的 `execute` 返回
  "用户取消了这组问题、请基于现有信息继续"的结论 —— **模型收到的是明确的取消语义，
  不是运行被中断**，它不会换个说法再问一遍。时间线的 `tool-result` 记
  `{ cancelled: true, answers: [] }`，历史重建据此把卡片标成「已取消」；
- `resumed=true` 的挂起事件**不重复落** `tool-suspended`，只补记 toolName，避免历史出现两张卡。
- **每道题都有"选项之外"的兜底输入**（2026-11-03 补）：单选题在选项末尾多一个「其他（自行填写）」，
  多选题是多一个可与其他项同时勾的「其他」，两类题下面都有一个自由输入框；在那里写文字等同选中「其他」
  （单选覆盖选中项、多选追加在末尾、清空即取消）。提交前由 `resolveAnswerValue` 把"选中项 + 自定义文本"
  合成答案（单选是字符串、多选是数组），**空文本不算作答** —— 必答题因此会拦住「下一题」，
  而不是把空串当答案交上去。问答类本身就是输入框，不再叠一层。


### 3.8 可审计 / 可复盘审视（自查结论：部分满足，有三处硬缺口）

审计要能回答「**谁、何时、对什么、做了什么、结果如何、花了多少**」；
复盘要能**把当时的情形重放出来**（输入是什么、模型回了什么、每步耗时与开销）。
按这两把尺子逐条对照现有设计：

| 要回答的问题 | 现状 | 判定 |
| --- | --- | --- |
| 谁发起的这一轮 | `conversations.user_id` 有；**`runs` 没有触发人** | ✗ 缺口 |
| 何时开始/结束 | `runs.started_at / finished_at / heartbeat_at` + 每事件起止 | ✅ |
| 用了哪个 agent、哪个模型、什么参数 | `runs.agent_key` 有；**模型与参数没按 run 记录** | ✗ 缺口 |
| **送给模型的输入到底是什么**（system prompt / 上下文集合 / 工具定义） | **完全没存** | ✗ **最大缺口：复盘因此不成立** |
| 模型回了什么（含推理） | `timelines` 的 `text` / `reasoning` 行 | ✅ |
| 调了哪些工具、入参出参 | `timelines` 的 `tool-call` / `tool-result`，完整不裁剪 | ✅ |
| 花了多少（轮 / 步 / token） | `runs.usage / step_count` + `conversations` 冗余列 | ✅ |
| 失败没有、失败在哪一环、为什么 | `runs.error_code / error_stage / error_detail` | ✅ |
| 中断 / 恢复过吗、恢复几次 | `recovery_count` + `status` 事件 | ⚠️ 有计数，但**重跑产生的重复条目没定义去重** |
| 谁归档 / 删除 / 停止 / 重试了 | 只有软删标记，**没有操作人** | ✗ 缺口 |
| 历史能不能被静默篡改 | 没有 append-only 约束，有 DB 权限即可 UPDATE/DELETE | ⚠️ 可强化 |
| 能不能导出复盘 | 没有 admin 审计接口与导出 | ✗ 缺口 |
| 留存多久 | 没有保留期策略 | ✗ 缺口 |

**结论**：审计「发生了什么」基本够用（时间线 + 消耗 + 错误），
但**复盘「为什么是这样」不够** —— 因为输入侧（提示词、上下文、工具定义、模型参数）没留下证据，
而这些东西会随代码演进而变，事后无法凭记忆还原。

**补强清单（8 项）**

1. **接上仓库已有的审计基建**（不新造）：三张表改继承 `AuditEntity`（`created_by` / `updated_by` /
   `deleted_by`），`setAuditUserProvider(() => requestContext.get('userId') ?? …)` 在 bootstrap 挂一次，
   `AuditSubscriber` 注册进 `DbModule.forRootAsync` 的 `subscribers`，删除走 kits 的 `safeDelete`
   （它类型上强制要求 `AuditEntity`）。代价：3 张表各多 3 列。
2. **`runs` 增加请求快照**（复盘的输入侧）：`request_snapshot` jsonb =
   `{ model, params{maxSteps,temperature}, agentKey, agentRevision, toolKeys[], skillKeys[],
   context{strategy,n,seqRange,truncated} }`；其中 `agentRevision` 是「提示词 + 工具清单 + 技能清单」的哈希值（用来判断"当时那套配置"和现在是否相同）。
3. **system prompt 正文进时间线**：落一行 `kind='system'`（role=`system`），同一会话提示词不变时只写一次，
   变了（`agentRevision` 变）再追加一行 → 复盘时按 `seq` 就能还原"当时完整的输入顺序"。
4. **`runs` 增加 `triggered_by` 与 `request_id`**：前者=发起人，后者=HTTP `X-Request-Id`，
   把审计记录与日志/告警串起来（排障时不用猜）。
5. **重跑的去重与标记**：`timelines` 增 `attempt`（默认 1），并对
   `(run_id, tool_call_id)` 建**部分唯一索引** `WHERE tool_call_id IS NOT NULL` ——
   恢复重跑重新产出的同一次工具调用**upsert 而不是插两行**（保住幂等键，也让审计不被重复条目迷惑）。
6. **动作事件带操作人**：`kind='status'` 的 payload 记 `{ status, reason, operator }`
   （如"用户点了停止""看门狗判超时""系统恢复重跑"）→ 时间线自身就是审计日志。
7. **审计查询与导出**：admin 鉴权的新接口 —— 按 `runId` 拉完整时间线 + 请求快照、导出 JSONL。
   复盘不导出等于没有（跨系统排查时没人会连你的库）。
8. **留存期显式化**：配置项（默认**永久**），若启用清理，清理动作本身必须留痕（记 `status` 事件），
   不能"悄悄没了"。

**两个边界口径（B 已拍板；A 是建议，等你一句话确认）**

- **A. 防篡改强度（已给出推荐：先不做 hash 链）**

  **hash 链是什么**：每条时间线行存两个校验值（哈希）—— 自己内容的 `hash` + 上一条的 `prev_hash`。
  改动任意一行 → 它的 hash 变 → 下一条里存的 prev_hash 对不上 → 一路错下去、一眼可见。
  类比：每页页脚都印着"上一页校验码"的账本，撕改中间一页后面立刻对不上。具体例子：

  ```
  第1行 内容="用户问：待办有哪些"                hash=abc123
  第2行 内容="AI 答：3 条" + 上一行 hash=abc123   hash=def456
  第3行 内容="用户问：第二条是什么" + 上一行 def456 hash=ghi789
  # 偷改第 2 行为"AI 答：5 条" → 它重算出的 hash 不再是 def456，
  # 而第 3 行仍写着"上一行 = def456" → 对不上，一眼可见
  ```

  **用途**：证明"这份记录从产生到现在没被任何人改动过"（对外举证、追责）。
  **防不住**：不能阻止改动（只能发现）；对方若能把整条链全部重算，链会自洽 ——
  所以真要用还必须"外部锚定"（每天把最新 hash 另存到日志 / 对象存储）。

  **它能/不能**：能**发现**改动，不能**阻止**改动；若对方能改代码并把整条链重算，链会自洽 ——
  所以完整方案还需要**外部锚定**（每天把那串最新哈希写到日志 / 对象存储，挪个地方）。只做链不做锚定是半成品。

  **代价**：`timelines` 多 2 列 + 写入多一次 sha256（可忽略）；同会话按 `seq` 串行链接；
  真正成本在运维（补数据、迁移都要保证链不断）与"容易被误当成绝对不可篡改"的心智负担。

  **推荐先不做**，改为做性价比最高的三层：① 应用层只追加（不提供改 / 删接口）；
  ② 部署文档写明**时间线表只授 `INSERT` + `SELECT`**（回收 UPDATE / DELETE）；③ 删除只做软删标记。
  将来有合规要求再补：两列 + 每日锚定 + 校验接口（升级路径通，无需现在留钩子）。
- **B. 删除口径（已拍板：只能删会话、只能软删）**

  - **可删的只有「会话」**：`POST /agent/conversation/remove` → 软删（写 `deleted_at` / `deleted_by`）；
  - **运行记录与时间线不提供任何删除入口**（只追加）：它们是复盘与审计的证据，用户无权删；
  - 软删的后果：会话从列表与接口消失（再访问返回 3304），但**数据仍在**，
    admin 侧审计查询可用 `includeDeleted` 开关看到（默认不显示）；
  - **软删前必须先结束在跑的运行**：若该会话有 `pending` / `running` 的 run，
    先走停止流程（`canceled`）再软删 —— 否则"用户看不到了、钱还在烧"；
  - 「脱敏删除（内容置空）」**不做**（既然只提供软删，就没有这个操作）。
    将来若有合规要求，再作为**独立的管理端操作**加，而不是用户接口的一部分。

### 3.9 上下文策略：按模型窗口的 70% 触发裁剪与压缩

**一句话**：以**模型上下文窗口的 70% 为触发线**，先裁剪（便宜）后压缩（花钱），全程留证；
落库永远完整，给模型的取舍必须记进 `request_snapshot`。

**① 窗口 W 从哪来（70% 的前提，三级解析）**

1. 配置覆盖 `AGENT_CONTEXT_MODEL_WINDOWS`（JSON 映射，最高优先，用于自建 / 新模型）；
2. 否则查 **tokenlens 的模型注册表**（`getContextWindow(modelId)` → `inputMax ?? combinedMax`）——
   前端 ai-elements 的 `context` 组件本来就用它，前后端共用同一套模型元数据，不手维护表；
3. 都没有 → 保守默认 `AGENT_CONTEXT_FALLBACK_WINDOW=32000`，**并打 warn 日志**
   （`ai.context.window.unknown`，带 modelId）—— 不静默，否则"为什么老是被裁"无从查起。

解析出的 W **随 `request_snapshot` 落库**（审计要能回答"当时按多大窗口算的"）。

**② 触发阈值与目标（比例都相对模型窗口 W，可配；默认值如下）**

| 情况 | 触发条件 | 动作 | 目标 |
| --- | --- | --- | --- |
| 正常 | 估算 ≤ **70% W** | 直接用 | — |
| **裁剪** | 估算 > 70% W | 从**最旧**开始丢事件（见下方保护规则） | 降到 **50% W** |
| **压缩** | 裁剪到 50% 仍装不下，或被保护内容本身就超 50% | 把最旧一段交给模型生成摘要，产出 `kind='summary'` 事件 | 降到 **40% W** |
| 兜底 | 压缩后仍 > 70%，或压缩失败 | 只保留「系统提示词 + 最近 1 轮」 | 仍超 → 报 3307（上下文超长），**不硬塞**（硬塞会被 provider 400） |

**为什么是 70%**：留 30% 给**输出 + 工具定义 + 系统提示词膨胀 + 估算误差**。
70% 是**触发线**，不是"可以塞满"的上限。
**为什么裁剪目标 50%、压缩目标 40%**：留出冷却区间，避免"压完立刻又触发"——
每次压缩都是一次真实付费的模型调用。

**顺序固定**：**先裁剪、后压缩**。裁剪零成本，压缩花钱，只有裁剪解决不了才动压缩。

**③ 保护规则（这些永不裁）**

- 系统提示词（含工具与技能声明）——它是行为定义，裁了就变了个 agent；
- 最近 `AGENT_CONTEXT_KEEP_RECENT_TURNS=3` 轮（保底能正常对话）；
- 当前这一轮的用户输入；
- **工具调用与结果的配对**：不能只留 `tool-result` 丢掉 `tool-call`（会产生非法消息序列），
  裁到一对就**整对保留或整对丢弃**。

**④ 单条工具结果的模型视图阈值**

给模型的单条 `tool-result` 不超过 `AGENT_CONTEXT_TOOL_RESULT_MAX_RATIO=10%` W；
超出时给模型的是"截断 + 明确提示已截断"（**落库仍是完整原文**，见 §4.6 保真原则）。

**④.1 累计预算与轮内复查（2026-10-29 加）**

单条上限按窗口**线性放大**：1M 窗口 × 10% ÷ 2 ≈ 20 万字符，等于"不裁"。真正撑爆上下文的是
「调用次数 × 每条多大」，所以再加两层：

1. **轮前累计预算**（`AGENT_CONTEXT_TOOL_RESULT_TOTAL_RATIO=30%` W）：组装上下文时，若本轮所有
   工具结果的字符总量超线，从**最旧**的再压一层（最近 4 条不动），并计入
   `request_snapshot.toolResultTrim`；
2. **轮内每一步复查**（Mastra 的 `prepareStep`）：每步开始前把同一预算套到"给模型的那份消息"上，
   超了就压旧结果（`runtime/turn-budget.ts`）。**只改模型视图**：时间线里的出参仍由录制器全量落库，
   Mastra 记忆里的消息对象不被修改。

为什么必须放到轮内：压缩只在轮前判定一次，而一轮里的工具往返可以几十步 —— 等这一轮结束再压，
钱已经烧掉了。这也说明「先裁剪后压缩」只覆盖**轮与轮之间**。

**⑤ 压缩的产物、冷却与降级**

- 产物：一条 `kind='summary'` 时间线事件，**摘要正文与元信息都入库**（不是只留"这里压缩过"的标记）：

  ```jsonc
  // timelines 行：kind='summary'
  {
    "payload": {
      "text": "……摘要正文（模型产出，完整保存）……",
      "coversSeqs": [[120, 899]],          // 它压缩掉了哪一段原文
      "model": "deepseek/deepseek-chat",
      "promptRevision": "sha256:…",        // 生成摘要用的提示词版本（提示词会演进）
      "sourceWindowTokens": 18240,         // 被压缩段落的估算 token
      "supersedes": null                   // 若是重新生成的摘要，指向被替代的那条 seq（旧行保留）
    },
    "attempt": 1,
    "usage": { "inputTokens": 18240, "outputTokens": 420, "totalTokens": 18660 },
    "started_at": "…", "finished_at": "…", "duration_ms": 3100
  }
  ```

  → "当时模型看到的早期信息到底是哪份摘要、由什么生成、花了多少"全在案；
  **摘要正文可查询、可展示、可导出**（会话历史接口会把 `summary` 事件一并返回，
  前端可选择显示一行"（已压缩早期 N 轮）"的提示）；
- **原文永不删除**：摘要只是"给模型看的新起点"，历史原文仍在时间线（只追加）；
- 冷却：压缩后从 40% 涨回 70% 才会再次压缩（不需要额外计时器，天然有间隔）；
- 重新生成：对同一段重新摘要 = **再落一条 `summary` 事件**（旧行保留、`supersedes` 指向它）——
  时间线只追加，不允许原地覆盖，否则复盘时"当时用的是哪份摘要"就说不清了；
- 降级：摘要生成失败 → **退回纯裁剪**（丢掉那一段最旧的），并记一条 `status` 事件
  （`reason='compact_failed_fallback_trim'`），让复盘能看出"这里本来该有摘要但没有"。

**⑥ 估算与校准（不装精确）**

本地没有各家 tokenizer，**裁剪预算用估算**（保守系数：中文按字、英文按 4 字符 ≈ 1 token，
宁可多裁也不爆窗）；**真实用量以 provider 返回的 `usage.inputTokens` 为准**。
`request_snapshot.context.estimatedInputTokens` 与 `runs.usage.inputTokens` 都落库 →
两者比值可用于校准系数（发现长期低估就调系数，而不是猜）。

**⑦ 配置项清单（app-config 的 `agent` 命名空间 → `.env`）**

```bash
AGENT_CONTEXT_TRIGGER_RATIO=0.7            # 触发线（相对模型窗口）
AGENT_CONTEXT_TRIM_TARGET_RATIO=0.5        # 裁剪目标
AGENT_CONTEXT_COMPACT_TARGET_RATIO=0.4     # 压缩目标
AGENT_CONTEXT_KEEP_RECENT_TURNS=3          # 最近几轮永不裁
AGENT_CONTEXT_TOOL_RESULT_MAX_RATIO=0.1    # 单条工具结果的模型视图上限
AGENT_CONTEXT_FALLBACK_WINDOW=32000        # 未知模型的保守窗口
AGENT_CONTEXT_MODEL_WINDOWS={"deepseek/deepseek-chat":65536}   # 按模型覆盖（最高优先）
```

`request_snapshot.context` 的落库形状（复盘成立的关键）：

```jsonc
{
  "strategy": "trim+compact",            // window | trim | trim+compact | fallback
  "model": "deepseek/deepseek-chat",
  "windowTokens": 65536,                 // 解析出的 W
  "windowSource": "registry",            // config | registry | fallback
  "triggerRatio": 0.7,
  "budgetTokens": 45875,
  "estimatedInputTokens": 41200,
  "includedSeqs": [[1043, 1137]],        // 实际带入的事件区间（摘要段 + 原文段，可多段）
  "droppedSeqs": [[120, 899]],           // 被裁掉的（如实记录，不隐藏）
  "summarySeq": 1043,                    // 用了哪条摘要顶替（无压缩时为 null）
  "toolResultTrim": { "trimmedCount": 1, "policy": "maxRatio=0.1" }
}
```

### 3.10 多实例下的推送与一致性（目标：连接落到哪个副本都行）

**总原则**：**不让任何状态只活在某个进程的内存里**。凡是"连接落在哪个副本会改变行为"的东西，
一律外置：Postgres 存真相，Redis 存运行期数据（可补发的输出记录、跨副本通知）。

**四类状态与位置**

| 状态 | 谁产生 | 放哪 | 多副本下怎么用 |
| --- | --- | --- | --- |
| 运行输出记录（供补发） | 正在跑的那个副本 | Redis（Mastra 的共享 cache 语义；按 `offset` 索引） | 重连落在**任意**副本都能按 offset 补发 |
| 实时内容转发 | 同上 | Mastra 的 pub/sub（`RedisStreamsPubSub`） | 副本 B 订阅到副本 A 的新内容，转发给自己持有的连接 |
| 业务真相（`timelines` / `runs` / `conversations`） | 同上 | Postgres（我们的表） | 任意副本可查、可续、可审计 |
| 状态广播（多标签页 / 多设备同步） | 同上 | 既有 `StreamHub`（Redis pub/sub） | **旁路通道**，不做主通道，避免两条真相 |

**客户端连接模型（不需要粘性）**

- **POST 建流**（AI SDK 协议）：落在副本 A → A 跑这一轮，把流写给客户端，同时写 Redis 输出记录；
- **GET 重连**（断线/刷新后）：可能落在副本 B → B 用 `observe(engineRunId, { offset })`
   从共享记录**补发**已产出的内容，再继续转发实时内容（经 pub/sub）；
- **不需要网关做 sticky session**（这正是把状态外置的目的）；但**网关必须放行长连接**：
  关闭响应缓冲（`x-accel-buffering: no`，§5.1 已写）、`proxy_read_timeout` ≥ 心跳间隔的数倍。

**心跳（必须做，否则"长思考"期间会被网关掐断）**

- `@mastra/ai-sdk` 导出了 `withSseHeartbeat`（已核实）→ 套在流上即可，间隔可配（默认 15s）；
- 必须**显著小于** `app-config` 里的 `keepAliveTimeout`（默认 75s）——否则前端表现是"想得久一点就断流"。

**stop / abort 跨副本（否则"停止"根本不生效）**

Mastra 的 abort 请求经 **pub/sub** 传递：默认 `EventEmitterPubSub` **只在本进程生效**。
所以 stop 端点必须配 `RedisStreamsPubSub` —— 否则用户点停止时，若请求落到另一个副本，
那一轮的生成**仍在继续**（用户以为停了，钱还在花）。

**恢复与看门狗的互斥**

- 恢复：多副本同时 boot 会抢同一条；`RedisStreamsPubSub` 实现了租约（`SET NX PX`，30s TTL）
  → 只有一个副本真正执行；仍按"单副本优先 + 租约兜底 + 上线实测"处理（§2.4 / §6.3）；
- 看门狗**不用分布式锁，用条件更新**（天然幂等）：

```sql
UPDATE runs SET status = 'failed', error_stage = 'timeout', finished_at = now()
WHERE id = $1 AND status = 'running' AND heartbeat_at < now() - interval '…'
```

  影响行数 = 1 的那个副本负责后续动作（写错误、广播状态、abort）。

**Redis 从"可选"变成"多实例必需"**

- 单副本：可以不配（退化为进程内，代价是"不能跨副本补发"）；
- 多实例：必须配 `@mastra/redis`（cache）+ `@mastra/redis-streams`（pub/sub）；
- **启动自检**：`AGENT_MULTI_INSTANCE=true` 却没配 Redis → **启动即失败**。
  宁可起不来，也不要悄悄降级成"偶发断流、停止不生效"这种最难查的故障。

**同一会话并发**：已由 `runs` 的部分唯一索引在 **DB 层**挡住（3306），与副本数无关（§3.7）。

### 3.11 架构图与数据链路

#### 3.11.1 架构图（分层与依赖方向）

```
┌──────────────────── 前端（apps/web）─────────────────────────────────────┐
│ /ai/chat 页：useChat（AI SDK v6 transport）+ ai-elements 组件             │
│   · 内容与业务状态来自**同一条** UI Message Stream（状态走持久 data part） │
│   · 刷新/断线：GET 重连（带 runId + offset）→ 无感补发，不重跑            │
└──────────┬──────────────────────────────────────────────────────────────┘
           │ POST /agent/chat/stream（建流） GET /agent/run/:id/stream（重连）
           │ POST /agent/chat（非流式） POST /agent/{status,list}（装配查询）
           ▼
┌──────────────── HTTP 边界（apps/server/src/common）─────────────────────┐
│ RequestContext(ALS/requestId) → RequestLogger → RequestMetrics           │
│ UserAuthGuard → RateLimitGuard → Zod 校验 → ResponseEnvelope             │
└──────────┬──────────────────────────────────────────────────────────────┘
           ▼
┌──────────────── AI 模块（apps/server/src/modules/ai）───────────────────┐
│ core/     配置 · agent 注册表 · Mastra 装配 · 编排服务 · 错误             │
│ agents/   一个 agent 一个声明（key / 名称 / 工具子集 / 技能 / 提示词模板） │
│ tools/    一个工具一个 bean + ToolBuilder（按 key 索引、装配期校验）      │
│ prompts/  eta 模板引擎（{{ }}），提示词唯一出口                           │
│ skills/   SkillLoader（SKILL.md 加载 + 校验 + references）                │
│ 会话运行时 会话/运行服务 · 上下文组装（裁剪+压缩）· 时间线落库 · 看门狗   │
└───────┬──────────────────────────────┬──────────────────────────────────┘
        │                              │ 落库（保真、不裁剪）
        ▼                              ▼
┌── Mastra 运行时 ──────────────┐  ┌── Postgres（真相）─────────────────┐
│ durable agent（可恢复）        │  │ conversations  会话 / 轮数 / 累计  │
│  stream · observe · recover   │  │ runs           运行 / 消耗 / 快照   │
│ 存储适配层（**我们写**）        │─►│ timelines      消息·推理·工具·摘要  │
│  只实现 workflows domain(9)    │  │（TypeORM 实体 + 迁移；只追加）      │
│ model provider（OpenAI 兼容）  │  └────────────────────────────────────┘
└───────┬───────────────────────┘
        ▼
┌── Redis（单副本可选 · **多实例必需**）──────────────────────────────────┐
│ Mastra cache（输出记录，按 offset 补发）                                 │
│ Mastra pubsub（跨副本转发 / abort / 恢复租约）                            │
│ 既有 StreamHub（状态旁路广播）· RateLimit · 分布式锁                      │
└─────────────────────────────────────────────────────────────────────────┘
```

**依赖方向**：`前端 → HTTP 边界 → AI 模块 → Mastra 运行时/Postgres/Redis`；
`AI 模块` 只依赖 `@repo/*` 与 Mastra 的公开入口，**不反向依赖 HTTP 边界**；
存储适配层是我们写给 Mastra 的**下推层**（它调我们，不是我们调它）。

#### 3.11.2 数据链路 A：正常一轮（建流 → 落库 → 推送）

```
用户输入
  │
  ├─(1) POST /agent/chat/stream { agentKey, messages }
  │
  ▼ 边界：UserAuthGuard → RateLimitGuard → Zod 校验
  │
  ▼ 会话运行时
  ├─(2) 解析/创建会话（conversations）→ 建 run（pending → running，起 heartbeat）
  ├─(3) 组装上下文：解析窗口 W（配置 → tokenlens → 默认 32k）
  │        W × 70% 触发 → 裁剪（目标 50%）→ 压缩（目标 40%，产出 summary 事件）
  │         └─ 记 runs.request_snapshot（includedSeqs / droppedSeqs / summarySeq / 各比例）
  ├─(4) 用户消息落 timelines（kind=text, role=user, seq 递增）
  ├─(5) durableAgent.stream(上下文)
  │        内部往返：模型调用（一步）→ 工具调用/结果 → 再调用模型 …
  │        每个 part 完成即落 timelines（text / reasoning / tool-call / tool-result / step）
  │        工具入参出参**完整**落库（不裁剪）
  ├─(6) toAISdkStream(version v6) + withSseHeartbeat → pipeUIMessageStreamToResponse
  │        同时把每个 chunk 写入 Redis 输出记录（带 offset）
  └─(7) 流结束收尾：读 totalUsage / steps / toolCalls
           ├─ 更新 runs（succeeded + usage + step_count + tool_call_count + 耗时）
           └─ 累加 conversations（turn_count / total_tokens，SQL 内原子累加）
```

#### 3.11.3 数据链路 B：断线重连（换一个副本也能接上）

```
客户端刷新 / 网络抖动
  │  GET /agent/run/:runId/stream?offset=N        ← 可能落在**另一个**副本
  ▼ 副本 B
  ├─ 归属校验（该会话属于当前用户）→ 否则 3304
  ├─ 无进行中的流 → 204（AI SDK 约定，前端据此结束重连）
  └─ observe(engineRunId, { offset: N, idleTimeoutMs, isAlive })
       ├─ 命中 Redis 输出记录 → 补发 N 之后的内容（**不重跑、不重复扣费**）
       └─ 订阅 pub/sub → 副本 A 的新内容实时续上
```

> **offset 落在块中间时不能直接补发**：AI SDK 的 UI 状态机要求
> `reasoning-delta` / `text-delta` 前必须有对应的 start。补发前由
> `runtime/stream-resume.ts` 把起点回退到当前块开头，找不到开头就补 start；
> 否则会出现 `Received reasoning-delta for missing reasoning part` 整页报错。

#### 3.11.4 数据链路 C：崩溃恢复与看门狗

```
进程被杀 / 重启 / 运行卡死
  │
  ├─ boot（OnApplicationBootstrap）
  │   ├─ 启动自检：AGENT_MULTI_INSTANCE=true 却缺 Redis → **启动失败**
  │   ├─ 取恢复租约（RedisStreamsPubSub：SET NX PX，30s TTL）→ 只有一个副本执行
  │   └─ recoverAllDurableAgents()
  │        ├─ 读快照（runs.snapshot，经我们的存储适配层）
  │        ├─ 重跑：重发 LLM 调用 + 重跑工具   ← 官方明文，**真花钱**
  │        │    └─ 工具幂等：唯一键 = engineRunId + toolCallId
  │        │       （timelines 部分唯一索引 → upsert，attempt + 1，不产生重复条目）
  │        └─ 失败 / 超次数（recovery_count 上限 1）→ interrupted（用户可手动重试 = 新建 run）
  │
  └─ 看门狗（各副本并行运行，用**条件 UPDATE 抢执行权**）
       UPDATE runs SET status='failed', error_stage='timeout'
       WHERE id=? AND status='running' AND heartbeat_at < now() - …
       影响行数 = 1 的副本负责：写错误 → 广播状态 → abort producer
```

#### 3.11.5 数据链路 D：上下文超限时的处理顺序（§3.9 的图化）

```
估算用量 vs 模型窗口 W
  │
  ├─ ≤ 70% W ─────────────────────────────► 直接使用（记快照）
  │
  ├─ > 70% W ─► 裁剪：从最旧丢事件
  │             保护：系统提示词 · 最近 3 轮 · 本轮输入 · 工具调用与结果**配对**
  │             目标：50% W ──► 达标则使用
  │
  ├─ 仍装不下 ─► 压缩：最旧一段 → 摘要（kind='summary'，正文+元信息入库）
  │             组装 = 摘要 + 其后原文；目标：40% W ──► 达标则使用
  │             失败则降级为纯裁剪 + 记 status(reason=compact_failed_fallback_trim)
  │
  └─ 仍超限 ─► 兜底：只留「系统提示词 + 最近 1 轮」──► 仍超 → 3307（不硬塞，硬塞会被 provider 400）
```

#### 3.11.6 数据入库时序图（谁、在什么时刻、写哪张表）

```
 前端        控制器/AI 服务        上下文组装        Mastra        时间线写入       Redis      Postgres
  │               │                  │               │              │             │           │
  │ 1 POST 建流    │                  │               │              │             │           │
  ├──────────────►│                  │               │              │             │           │
  │               │ 2 鉴权·限流·Zod   │               │              │             │           │
  │               │ 3 会话归属校验 ──────────────────────────────────────────────────────────►│ SELECT conversations
  │               │ 4 建 run（pending）─────────────────────────────────────────────────────►│ INSERT runs
  │               │   ↳ 已有 running → 部分唯一索引拒绝 → 3306                                │
  │               │ 5 置 running + heartbeat ───────────────────────────────────────────────►│ UPDATE runs
  │               │ 6 组装上下文 ───►│               │              │             │           │
  │               │                  │ 7 取窗口事件 + 最新 summary ─────────────────────────►│ SELECT timelines
  │               │                  │ 8 裁剪 / 压缩 │              │             │           │
  │               │                  │ 9 压缩则落摘要 ─────────────►│ INSERT timelines(kind=summary)
  │               │ 10 落输入快照 ──────────────────────────────────────────────────────────►│ UPDATE runs.request_snapshot
  │               │ 11 落用户消息 ────────────────────────────────►│ INSERT timelines(user)
  │               │ 12 agent.stream ──────────────►│              │             │           │
  │               │                  │              │ 13 工具往返（业务事务，见下）│          │ → 业务表
  │               │ 14 part 流 ◄───────────────────┤              │             │           │
  │ 15 SSE 帧 ◄───┤                  │              │              │             │           │
  │               │ 16 每个 part 完成 ────────────────────────────►│ INSERT timelines
  │               │    （text/reasoning/tool-call/tool-result/step；**完整不裁剪**）          │
  │               │ 17 同一时刻追加输出记录 ───────────────────────────────────►│ append(offset)
  │               │ 18 流结束：读 totalUsage / steps / toolCalls ────┤           │           │
  │               │ 19 终态 + 消耗 ───────────────────────────────────────────────────────►│ UPDATE runs(succeeded + usage + counts)
  │               │ 20 会话累加（SQL 内原子累加）────────────────────────────────────────────►│ UPDATE conversations
  │               │ 21 清 active_stream_id · 旁路广播 ────────────────────────►│           │
```

**写入顺序的设计意图**：先落「**意图**」（run）→ 再落「**输入**」（用户消息 + 请求快照）→
再逐步落「**输出**」（每个 part）→ 最后落「**结果**」（终态 + 统计）。
于是**在任意一点崩溃，库里都是自洽且可解释的** —— 见下面的不变量表。

**事务边界（容易误解，必须写明）**

- AI 侧落库**不用跨表大事务**：流式写入是长过程（可能几分钟），包进一个事务会长时间占连接、
  也会和"边跑边落"的目标冲突。因此是**逐条追加**（允许部分成功）；
- 工具的业务写入（若接入）走业务 service 自己的 `@Transactional()`，
  **与 AI 落库不在同一事务**：业务写成功而时间线落库失败时，靠"时间线缺行 + run 状态"体现，
  **不靠回滚**（回滚会连带撤掉用户已经看到的业务结果）；
- 因此幂等键（`engine_run_id + tool_call_id`）是必须的：重跑时 upsert，而不是再插一条。

**崩溃点不变量（每个点都能说出"库里应该是什么样"）**

| 崩溃时停在 | 库里状态 | 启动后处置 |
| --- | --- | --- |
| 建 run 之前 | 什么都没有（或只有会话） | 无动作 |
| run = `pending` | 有 run、无输出 | 标 `interrupted`（未真正开始，无需重跑） |
| run = `running`，用户消息已落、无输出 | 输入在、输出无 | 交给恢复流程：能恢复则重跑，否则 `interrupted` |
| run = `running`，部分 part 已落 | 部分时间线 | 同上；重跑时按 toolCallId upsert + `attempt+1`，**不产生重复条目** |
| run 已 `succeeded` 但 usage 未写 | 唯一的不一致窗口（收尾阶段崩溃） | **消耗如实为空**，不回填估算值（§4.7）；前端显示"—" |
| 流中途失败（进程活着） | 已产出内容保留 | run → `failed`（`error_stage` 指明环节），用户可手动重试（新建 run） |

**两个"同一时刻"是刻意设计**：

1. **落库与写输出记录同时发生**（步骤 16/17）：落库保证**刷新后能重建**（持久真相），
   Redis 输出记录保证**重连能补发且不重跑**。少了任一个都会缺一种体验；
2. **心跳与落库并行**：`withSseHeartbeat` 只写 SSE 注释帧、不碰数据库 ——
   长思考期间连接不断，但库里不会因为心跳产生噪音。

### 3.12 runs 与「运行中进度」：进度放 Redis，结果放 Postgres

**机制**：消息到达时 `runs` **双写** Postgres + Redis；推理过程中**只更新 Redis**（高频、轻量）；
跑完后 **先更新 Postgres 落最终结果，再删 Redis 里的进度**。

**时刻表（顺序不可颠倒）**

| 时刻 | Postgres | Redis | 为什么这个顺序 |
| --- | --- | --- | --- |
| 消息到达 | `INSERT runs`（pending → running） | 写进度键（status / streamId / startedAt） | **先 PG 后 Redis**：Redis 只存进度，不能当真相；PG 成功而 Redis 失败只是"没有实时进度"，记 warn 继续跑，**不因此拒绝请求** |
| 推理过程中 | **不写**（除每 part 完成时落 `timelines`） | 高频更新进度（stage / offset / heartbeat / 当前步 / 增量 usage） | 避免长过程里反复 UPDATE PG 同一行（锁 + WAL 放大） |
| 跑完 | `UPDATE runs`（最终结果 + 消耗 + 统计） | **再删进度键** | **先 PG 后删除**：反过来会留下"没有进度、也没有结果"的窗口，看门狗与前端都会误判 |
| 进程崩溃 | 停在 `running` | 进度可能仍在（或已过期） | 看门狗按 **PG 的 `heartbeat_at`** 判定，不依赖 Redis 是否有键 |

**三条不可违反的规则**

1. **真相只在 Postgres**：Redis 里的进度**可以丢**（丢了只影响"实时进度可见性"，不影响最终一致性）——
   因此**不需要分布式事务 / 双写一致性协议**，这正是我们要的取舍；
2. **进度键必须有 TTL**（如 6h，配置项）：进程被 SIGKILL 时来不及删，靠 TTL 自愈；
   TTL 必须 > 最长可能的运行时长，否则长任务中途进度过期；
3. **进度里只放"到哪了"，不放内容**：内容属于 `timelines`（真相）与 Redis 输出记录（补发），
   三处各司其职，避免同一份内容存三遍。

**进度键结构（单键 Hash，增量 HSET，不要整对象重写）**

```
key: agent:run:{runId}          TTL: 6h
  status        running | pending
  stage         queued | generating | tool:{toolKey} | compacting | finishing
  engineRunId   Mastra 的 runId（observe / recover 用）
  streamId      activeStreamId（重连与停止用）
  offset        输出记录的最后位置（重连从这里接）
  step          当前第几步（配合 AGENT_MAX_STEPS）
  heartbeatAt   心跳时间（看门狗的第一判据，同时冗余到 PG）
  usage         { inputTokens, outputTokens } 增量估算
  updatedAt     最近一次进度更新
```

**写入频率**：进度更新按 **1s 节流合并**（同一秒内多次变化只写一次），
且只 HSET 变化字段 —— 长回复每秒几十个 chunk，不节流会把 Redis 打满。

**读进度的四类消费者**

| 消费者 | 用它做什么 |
| --- | --- |
| 重连端点（GET） | 取 `offset` 决定从哪补发；取 `streamId` 判断"是否还有进行中的流"（无 → 204） |
| 停止端点 | 取 `streamId` + 通过 pub/sub abort（多副本必须共享 pubsub，§3.10） |
| 看门狗 | 交叉验证 PG 的 `heartbeat_at`（PG 为第一判据，进度辅助定位"卡在哪一步"） |
| 前端旁路（多标签页） | 展示"另一处正在跑 / 当前到第几步"，不必再拉整条流 |

**与其他两样东西的职责区分（别混）**

| 东西 | 位置 | 生命周期 | 用途 |
| --- | --- | --- | --- |
| 运行中进度 | Redis 单键 Hash | 本轮运行期间（TTL 兜底） | **到哪了**（本节机制） |
| 输出记录 | Redis（Mastra cache 语义） | 到本轮结束 + 留存期 | **补发**：断线后按 offset 续上，不重跑 |
| 运行快照 | PG `runs.snapshot` | 随 run 长期保留 | **恢复**：进程死后重跑的依据（经存储适配层） |

**异常时不变量**（与 §3.11.6 的崩溃点表配套）

| 异常 | 结果 | 处置 |
| --- | --- | --- |
| PG 写成功、Redis 写失败 | 能正常跑，只是没有实时进度 | 记 warn，继续；不重试阻塞主流程 |
| PG 写失败 | 请求失败（连 run 都没有，不该继续） | 直接返回边界错误，不产生半截状态 |
| 最终结果更新成功、删除进度失败 | 残留进度键 | 靠 TTL 自愈；runId 唯一，不会被复用 |
| 最终结果更新失败、删除进度成功 | 库里 `running`、无进度 | boot 时按 `heartbeat_at` 判定 → 恢复或标 `interrupted`；**消耗如实为空**（§4.7） |
| 进程被 SIGKILL | 进度与 PG 都停在中间态 | 看门狗 + 恢复流程接管；重跑按幂等键 upsert |


### 3.13 恢复链路（端到端）：服务挂了怎么继续、刷新了怎么重连

先把两种"断"分清，它们的处理方式完全不同：

| 情况 | 那一轮还在跑吗 | 处理 |
| --- | --- | --- |
| **客户端断了**（刷新、断网、切后台） | **还在跑**（服务端不受影响） | 前端重连即可补齐内容，**不重跑** |
| **服务端挂了**（进程崩溃、重启、滚动更新、OOM） | **停了** | 只能**重跑**（官方明文：会重发模型调用、重跑工具） |

#### 3.13.1 服务挂了怎么继续

```
① 发现
   副本定期检查：runs.status = running 且 heartbeat_at 已过期（阈值可配，默认 30s）
   → 或者启动时扫一遍（boot 阶段）

② 决定谁来干（避免多个副本同时恢复同一条）
   去 Redis 抢恢复租约（SET NX PX，30s TTL，RedisStreamsPubSub 自带）
   抢到的副本执行，没抢到的什么都不做

③ 恢复执行
   recoverAllDurableAgents() / recoverActiveRuns({ runId })
   → 从快照（runs.snapshot，经我们写给 Mastra 的存储适配层）重建现场
   → 从最后一个快照点继续跑：**重发模型调用 + 重跑工具**（真花钱、真耗时）

④ 重跑时不产生脏数据
   工具调用按 (engine_run_id + tool_call_id) upsert，attempt 次数 +1
   → 时间线里不出现两条一模一样的工具调用
   → 业务写入要幂等（写工具用同一个幂等键只会写一条）

⑤ 输出继续往两边写
   新产出继续落 timelines（Postgres，真相）与 Redis 里的输出记录（供小范围补发）
   → 前端若已重连，会看到"恢复后继续输出"

⑥ 收尾
   跑完 → UPDATE runs（succeeded / failed + 消耗 + 统计）→ 累加会话 → 删 Redis 进度键
   恢复次数超上限（recovery_count 最多 1）或恢复失败 → runs.status = interrupted
   → 前端如实提示"本轮已中断，可重试"（重试 = 新建一轮，不是复活旧轮）

⑦ 兜底看门狗（与恢复并行，互斥用条件 UPDATE）
   总时长或心跳超限且恢复不了 → runs.status = failed（error_stage = timeout）+ abort
```

**用户看到什么**：服务挂的那几十秒里，前端不再有新内容（因为进程没了）；
等恢复副本重跑起来，前端会看到**状态变成"正在恢复"，随后内容继续**。
必须如实告知"这一轮是恢复后重跑的"，因为重跑可能重复输出一小段（见 §3.13.3）。

#### 3.13.2 前端刷新页面怎么重连

```
① 刷新后先问"这一轮还在跑吗"
   POST /agent/run/status { runId }  →  { status, offset, agentKey, conversationId }
   （offset = 已经从 Redis 输出记录里发出去的位置）

② 还在跑（status = pending / running）→ 重连 SSE
   GET /agent/run/{runId}/stream?offset={offset}
   · 校验会话归属（不是自己的 → 3304）
   · observe(engineRunId, { offset }) → 先把 offset 之后的内容补发（不重跑）
     → 再订阅 pub/sub，把后续实时内容续上（可能来自另一个副本）
   · 没有进行中的流 → 204（前端据此停止重连）
   前端写法：useChat({ resume: true })（挂载时自动重连）；
   **不要**自己在 useEffect 里调 resumeStream()（§5.6 第 5 条）

③ 已结束（succeeded / failed / interrupted / canceled）→ 不重连流
   POST /agent/timeline { conversationId, runId? } → 拿 timelines 重建
   → 消息、推理、工具调用与结果、摘要都在里面，渲染成完整历史
   ⚠️ 这是**分页接口**（`BasePaginateSchema`：`size ≤ 100`），而历史重建要的是**完整**时间线：
   前端必须**翻页取全**（`page` 递增到 `items.length >= total`），不能写一个大 `size`
   —— 越界会直接 400（踩过：会话页原先传 `size: 500`，于是"点会话什么都不显示"）。
   同理，"按 run 拉子助手明细"也必须翻页。

④ 补发失败也不丢内容
   Redis 输出记录过期/丢失 → 退化成"先按 timelines 拉历史，再接后续新内容"
   （可能有一次跳变，但内容不丢 —— timelines 才是完整真相）
```

#### 3.13.3 这套链路为什么能成立 / 做不到什么

**能成立，是因为四样东西各管一段**：

| 存哪 | 存什么 | 用来干什么 |
| --- | --- | --- |
| Postgres `timelines` | 发生过的每一件事（完整、不裁剪） | **刷新后重建内容**、复盘、审计 |
| Redis 输出记录 | 本次运行按顺序产出的内容片段 | **重连时补发**（不重跑） |
| Postgres `runs.snapshot` | Mastra 的运行快照 | **进程死了能重跑** |
| Redis 运行中进度 | 跑到第几步、当前在干什么、心跳 | 前端看进度、看门狗判超时、停止按钮找目标 |

**做不到的（如实说，别承诺）**：

1. **崩溃后无法"无重复地继续"**：官方明文会重发模型调用、重跑工具。文本部分可能重复一小段；
   工具条目靠 `tool_call_id` upsert 去重，但**重复的模型费用无法避免** ——
   这也是 `recovery_count` 上限设为 1 的原因（防止反复烧钱）；
2. **Redis 输出记录丢失且快照不可用**（例如存储适配层写失败）→ 无法恢复，只能标 `interrupted`；
3. **网络分区**（副本连不上 Redis）：输出记录写不进去 → 续流能力降级，
   但**落库仍继续**（Postgres 可用就行），所以这一轮的内容最终不会丢，只是刷新后要重新拉历史。


### 3.14 「core bean」与动态子 agent（**本轮修正，以此为准**）

> **机制演进（2026-10-01）**：`AgentCore` / `asTools()` 已取消 —— 规划 / 子 agent / 取页都是
> **工具组**（`@ToolGroup` + 方法级 `@ToolDecl`，一个方法一个工具），`AGENT_TOOL_GROUPS` 汇总工具组实例。
> 口径见 `docs/design/ai-agent-tool-engine.md` §5.2；本节其余"core bean"表述保留作历史。

本节覆盖前面所有关于多 agent 的描述。修正来自四条要求（原文）：

> 1. 我们会有 core 的 bean，这些 bean 会有 `asTools` 方法，比如 planner；
> 2. 子 agent 的 system prompt 是动态的，由主 agent 自己创建，除了没有子 agent 的 tool，其他 tool 也都能使用；
> 3. 子 agent 的所有明细都要入库；
> 4. 子 agent 也是一个 core bean，主 agent 通过调用工具创建。

**被推翻的旧设计**：装配期用 `AgentSpec.subAgents` 静态声明委派关系，Mastra 把子 agent 编译成
`agent-<key>` 工具；子 agent 有自己的静态提示词（`analyst.eta`）与固定工具面。
它与"prompt 由主 agent 现写"「通过工具创建」正面冲突，**已整体删除**（含 `agents/analyst.agent.ts`、
`prompts/templates/analyst.eta`、`createMastra` 里的 `agents:{}` 静态委派、`AgentDefinition.subAgents`）。

#### 3.14.1 core bean：跨业务的运行时能力，用 `asTools()` 交出来

```ts
/** ai/agents/types.ts */
export interface AgentCore {
  /** core bean 的 key（诊断 / 日志用，与工具 key 不是一回事） */
  readonly key: string
  /** 这个 core 提供给 agent 的工具（0..n 个） */
  asTools(): readonly AgentTool[]
}
```

工具池由此有**两个来源**，由 `ToolBuilder` 统一汇总成一张 `key → 工具` 表（重复 key 直接启动失败）：

| 来源 | 目录 | 是什么 | 依赖特征 |
| --- | --- | --- | --- |
| 业务工具 bean | `ai/tools/*.tool.ts` | 某个业务模块的操作（若接入） | 注入业务 service，与业务接口同一条链路 |
| **core bean** | `ai/core/*.core.ts` | **跨业务的运行时能力**（规划、子 agent） | 注入仓储 / runner / 技能加载器，不绑定任何业务模块 |

为什么必须分开：planner 与 sub-agent 不是"某个业务的操作"，它们要碰**运行时会话与运行记录**；
把这种依赖塞进业务工具 bean 会让业务模块反向依赖 AI 运行时（依赖方向就错了）。

现有两个 core bean：

| core bean | 提供的工具 | 说明 |
| --- | --- | --- |
| `PlannerCore` | `write-plan` | 自建无状态规划工具（不依赖 Mastra memory；计划由运行时落成 `plan` 事件） |
| `SubAgentCore` | `run-sub-agent` | **动态创建并运行子 agent**（本节的其余部分） |

**依赖方向（必须保持，否则 DI 成环）**：

```
AGENT_TOOLS(业务工具 bean) ─┐
                            ├─→ ToolBuilder（汇总 / 校验 / 按 key 取用）
AGENT_CORES(core bean) ─────┘        ↑ 只被装配层与编排层消费

PlannerCore  →  （无额外依赖）
SubAgentCore →  AgentRunner → 仓储 / 技能加载器 / 配置
```

core bean **不注入 `ToolBuilder`**。子 agent 需要的工具面由**编排层**算好、经 `requestContext` 传进来
（§3.14.4）——这样"子 agent 能用什么工具"这条规则只有一处定义，且不引入装配环。

#### 3.14.2 子 agent 是**运行期对象**，不是注册表成员

工具入参（给模型看的数据结构）：

| 字段 | 必填 | 含义 |
| --- | --- | --- |
| `name` | 是 | 子 agent 的短标识（展示 + 入库 `agent_key = sub:<name>` 用） |
| `system_prompt` | 是 | **由主 agent 现场撰写**的子 agent 系统提示词（没有静态模板可套） |
| `task` | 是 | 交给它的任务（作为子 agent 的第一条用户消息） |

执行方式：调用时 `new Agent({ id, name, instructions: system_prompt, model, tools, skills })` 造一个
**临时实例**，跑完即弃 —— 不注册进 Mastra 注册表，因此不会污染 agent 清单、也不会与同名实例冲突。

| 面 | 规则 | 理由 |
| --- | --- | --- |
| 工具面 | **全部工具 − 委派类工具**（`AgentTool.delegation === true`） | 你的要求原文；同时**天然杜绝无限递归**（子 agent 没有创建子 agent 的工具） |
| 技能面 | 与父 agent 相同（`SkillLoader` 的解析结果） | 工具既然全给，技能没有单独收紧的道理 |
| 模型 | 默认沿用默认模型；`subAgent.model` 可覆盖（留位） | 子任务通常该用便宜模型，但不预设 |
| durable | **不开**（子 agent 是临时对象，恢复由父 run 重跑 spawn 工具承担） | 见 §3.14.6 |

> 问答能力（`ask-user-questions`，向用户提问并挂起）**只挂在主 agent 上**，不在子 agent 的工具面里。
> 子 agent 是临时执行体，没人能回答它 —— 缺信息或要拍板时，它必须把问题和已知前提写进结论交回主 agent。
>
> 子 agent **可以并行**（同一步里模型派多个时一起跑），但同一父 run 最多同时跑 3 个，超出的排队；
> 打开并行的开关是主 agent 的 `toolCallConcurrency: { strategy: 'called' }`，闸门与配额见 §3.14.7。

#### 3.14.3 子 agent 的明细怎么入库（要求 3 的答案）

**子 agent = 一个独立 run 行**（同一张 `runs` 表，不做第二张表），父子的差别只在两列：

| 列 | 根 run（一轮问答） | 子 run（子 agent） |
| --- | --- | --- |
| `parent_run_id` | `NULL` | 父 run id（**逻辑引用，无物理外键**） |
| `depth` | `0` | 父 `depth + 1`（当前恒为 1） |
| `agent_key` | 注册表里的 agent key | `sub:<name>`（不在注册表，故解析不到，这是有意的） |
| `tool_call_id` | `NULL` | 父那次工具调用的 id（**幂等键**，见 §3.14.6） |

明细分三处落，**都不裁剪**：

| 位置 | 内容 | 用途 |
| --- | --- | --- |
| `runs.request_snapshot` | `{ name, systemPrompt, task, toolKeys, parentRunId }` 全量 | "子 agent 为什么这么干"的唯一证据（动态 prompt 不落库就等于不可审计） |
| `timelines`（子 run 的） | 任务（user）/ 推理 / 文本 / 工具调用与结果 / 每步用量 / 错误 | 与主 agent **同一套录制器**（`StreamRecorder`），细节不缩水 |
| 上下文组装 | **排除**子 run 的事件（`rootOnly`） | 子 agent 的内部过程是审计资料，回灌给主模型既费窗口又污染上下文 |
| 父 run 的 `timelines` | 那次 `run-sub-agent` 的入参与出参（出参含 `subRunId`） | 父→子的索引；复盘时从父点进子 |

因为子 run 与父 run **同属一个会话**，`POST /agent/timeline/list` 一次就能拉全整棵树，
前端按 `runId` 分组渲染成嵌套（数据结构上不需要递归查询）。

**统计口径（与 §4.7 一致，不许含糊）**：

- **轮数只数根 run**（`parent_run_id IS NULL`）—— 子 agent 不是"一轮问答"，不该让会话轮数虚高；
- **消耗汇总进父 run**：收尾时把子 run 的 usage 加总写进父 `usage.subAgents`，父的合计**已含子**；
- 会话累计（`conversations.total_tokens`）按**根 run** 的合计累加 → **不重复计费**；
- **步数与工具次数各 run 只记自己的**（一行一份）：`runs.step_count` 的语义是"**这个 run** 调了几次模型"，
  把子 agent 的步数混进父的列，会让"本轮 3 步"无法与"我自己调了 3 次模型"区分。
  要看整轮总工作量 = 父 + 子（前端按父子树天然能算，而且子 agent 的步数/工具次数已经作为
  `run-sub-agent` 的工具结论写进了父的时间线里 —— 不查子 run 也看得到）。

**并发保护要跟着改**：`uk_run_active_conversation`（同一会话只允许一轮进行中）必须加
`AND parent_run_id IS NULL` —— 子 run 与父 run **同时 running 是正常的**，不加这一条子 agent 一跑就撞唯一键。

#### 3.14.4 运行时信封：工具怎么知道"我在哪一轮"

工具不能自己猜上下文。编排层（`AgentChatService`）在发起这一轮时，把信封塞进 Mastra 的 `requestContext`：

```ts
requestContext.set('agentRuntime', {
  conversationId,
  parentRunId,      // 当前这一轮（子 agent 拿它当父亲）
  depth,            // 当前深度（根为 0）
  childTools,       // 算好的子 agent 工具面（全部 − 委派类）
  childSkills,      // 子 agent 的技能面
})
```

工具侧只读四样东西（都已核实存在于 `ToolExecutionContext`）：

| 来源 | 用途 |
| --- | --- |
| `requestContext` | 运行时信封（会话 / 父 run / 深度 / 子工具面） |
| `context.agent.toolCallId` | **幂等键**（重放时同一个 id 只生效一次） |
| `context.writer`（`ToolStream`） | 把子 agent 的实时明细写进**父的同一条流**（§3.14.5） |
| `context.abortSignal` | 用户停止时往下传到子 agent（停止要停整棵树） |

#### 3.14.5 子 agent 的实时明细怎么到前端（与 §5 同一条流）

`context.writer.write({ type: 'data-sub-agent', id: subRunId, data: {...} })`，
**已核实**（`@mastra/ai-sdk` 源码里 `chunk.type.startsWith('data-')` 直接透传）这类块会变成
AI SDK 的 `data-sub-agent` part，和主内容走同一条 SSE：

| data 字段 | 含义 |
| --- | --- |
| `runId` / `name` / `status` | 哪个子 agent、现在什么状态（`running` / `succeeded` / `failed` / `canceled`） |
| `delta: { kind, text }` | 增量片段（`kind` = `text` / `reasoning`），前端按 `id` 累积 |
| `event: {...}` | 工具调用与结果、步骤边界、错误（结构化，供嵌套面板渲染） |
| `usage` | 收尾时的这一子 run 的消耗（与 §4.7 同口径） |

**两种块要分清（踩过的坑）**：AI SDK v6 的 `data-*` part 是**按 `id` 归并**的（同 id 后者覆盖前者），
所以：

| 块 | id | 用途 |
| --- | --- | --- |
| `data-sub-agent` | **带**（= 子 run id） | 状态快照：`status` / 结论 / 步数与工具次数 / usage —— 每次覆盖，前端读到的永远是当前态 |
| `data-sub-agent-delta` | **不带** | 增量片段（`kind` = `text` / `reasoning`），一块一个，前端按到达顺序累积 |

前端把增量拼成流式文本、用状态块渲染面板头与收尾信息；**断线重连复用同一套机制**
（Redis 输出记录里本来就按顺序存着这些块，补发即可，不需要第二套通道）。

非流式接口（`/agent/chat`）没有 writer：跳过实时出口，**只落库**（前端看历史，内容一样全）。

#### 3.14.6 幂等与恢复（接 §3.3 / §3.4）

| 场景 | 行为 |
| --- | --- |
| 重放时同一 `(parent_run_id, tool_call_id)` 已有**成功**的子 run | **直接复用它的结论**：不重跑、不重复扣费（工具返回上次的结果） |
| 已有的子 run 是**失败 / 取消** | 允许**新一轮尝试**：新 run 行，父仍指向同一父；复盘能看到"同一 toolCallId 的两次尝试" |
| 父 run 崩溃恢复 | 子 agent 不做 durable（临时对象）→ 重跑 spawn 工具 → 走上表两条规则 |
| 进程死在子 agent 里 | 看门狗按同一套判据（心跳 / 总时长）把孤儿子 run 判 `failed`，并记 `error_stage = subagent` |

#### 3.14.7 配额（防止一个提示词把钱包烧穿）

| 配置 | 默认 | 作用 |
| --- | --- | --- |
| `subAgentMaxPerRun` | 4 | 同一父 run 下的子 run **总数**上限；超出**不抛异常炸整轮**，而是把"配额已满"作为工具结论返回给模型 |
| 并发（代码常量） | 3 | **同时运行**的子 agent 上限（`SUB_AGENT_MAX_CONCURRENT`）。超出的**排队**，跑完一个再进一个；与总数上限是两回事 |
| `subAgentMaxDepth` | 1 | 深度上限（当前工具面已保证为 1，留配置位给将来） |
| `subAgentMaxSteps` | 沿用 `AGENT_MAX_STEPS` | 单个子 agent 的步数上限 |
| `subAgentTimeoutMs` | 沿用 `runTimeoutMs` | 单个子 agent 的墙钟上限 |

三条实现要点（改并发相关逻辑前必看）：

- **工具调用本身要允许并行**：主 agent 的 `agent.stream` / `agent.generate` 传
  `toolCallConcurrency: { strategy: 'called' }`。默认的 `available` 策略只要工具集里有
  `ask-user-questions`（挂起类），就会把**整步**工具调用压成串行 —— 这是"子 agent 只能一个一个跑"的直接原因；
  `called` 只让"真的调用了挂起工具的那一步"串行。
- **并发闸门按父 run 计**（`KeyedSemaphore`，`AgentRunner`）：槽位在子 agent 整个生命周期里占着，
  成功 / 失败 / 取消都释放；第 4 个在 `acquire` 上排队，不占用配额、也不会被拒。
- **配额判定与建子 run 串行**（按父 run 的 promise 队列）：并行后两个调用同时 `count → create`
  会一起看到"还差一个"，一起越过 `maxPerRun`；排队只包这两次 DB 往返，不挡执行。

#### 3.14.8 本轮改动面（自查用）

| 动作 | 对象 |
| --- | --- |
| 新增 | `ai/core/envelope.ts`（`AgentCore`）、`ai/tools/planner/planner.core.ts`、`ai/tools/subagent.core.ts`、`ai/runtime/agent-runner.ts`（子 run 执行器） |
| 改动 | `ToolBuilder`（两个来源 + `buildDelegable()`）、`AgentChatService`（注入运行时信封；收尾汇总子 run 消耗）、`runs` 实体与迁移（`parent_run_id` / `depth` / `tool_call_id` + 唯一索引换条件）、`AGENT_CORES` 装配 |
| 删除 | `AgentSpec.subAgents`、`AgentDefinition.subAgents`、`agents/analyst.agent.ts`、`prompts/templates/analyst.eta`、`createMastra` 的 `agents:{}` 与拓扑排序 |
| 数据结构 | 新增 `AgentRunStopResult*`（已有）、`AgentRunModel` 增 `parentRunId` / `depth`；`AgentTimelineItemModel` 增子 agent 归属信息 |
| 测试 | 重写子 agent 用例（core bean 聚合 / 动态创建 / 明细入库 / 工具面继承 / 幂等去重 / 配额 / 流里的 `data-sub-agent`） |

### 3.15 命令执行（`bash`）与运行环境注入（**本轮新增，以此为准**）

#### 3.15.1 需求与硬约束

需求两条（用户口径）：**做一个跨平台的命令行工具给 agent 调用**；**系统指令里告知是什么操作系统、当前日期时间**。

硬约束（按"三端不一致 / 挂死 / 烧资源"三类真实事故点定）：

| 约束 | 为什么 |
| --- | --- |
| 三端一致（Windows / Linux / macOS） | 命令语法与 shell 不同；用户可能在任意一端部署 |
| 超时必须**真杀掉进程树** | 只杀 shell 会留下孤儿孙进程（资源泄漏） |
| 输出必须有上限 | `ls -R /` 这类命令能把内存打满 |
| 失败**永不抛异常** | 工具抛异常会把一整轮判失败；失败应当作为"结论"回给模型，让它自己纠正 |
| 可被用户停止 | 停止要连命令一起停，不是只断前端连接 |
| 每次调用可审计 | 让模型在本机跑命令是敏感能力，入参出参必须可复盘 |

#### 3.15.2 新能力放哪里：机制在 kits，策略在 AI 模块

| 层 | 位置 | 职责 |
| --- | --- | --- |
| 机制（基础设施） | `packages/kits/src/foundation/command/`（`CommandRunner` + `command.platform.ts` + `CommandModule`） | 跨平台执行：shell 解析、超时、杀进程树、输出上限、取消、结果结构化 |
| 策略（AI 模块） | `apps/server/src/modules/ai/tools/bash.tool.ts`（工具组 `BashTool`） | 开关、工作目录边界、时长 / 输出上限、审计日志 |
| 提示词 | `prompts/templates/partials/tools.eta`（「`bash` 怎么用」） | 什么时候用 / 不用、能力问题先验证、有副作用先问 / 只读公开请求可直接跑、失败要读懂原因 |

**为什么用 `execa` 而不是自己拼 `child_process`**（早先手写过一版，已弃）：三条硬约束恰好是它的内建能力 ——
`shell` 在 Unix/Windows 各自的默认解释器、`killDescendants`（Unix 进程组 / Windows `taskkill`）、
`reject: false` 把"非零退出 / 超时 / 取消 / 输出超限 / 起不来"都落成结果字段
（`timedOut` / `isCanceled` / `isMaxBuffer` / `exitCode`），比在 catch 里猜错误码可靠。
手写版在 Windows 上**无解**（没有进程组信号，孙进程会残留）。
依赖声明在 `packages/kits/package.json`（`execa@^10`，engines ≥22，与 `node:26-alpine` 基线一致）。

**提示词的结构口径**（用户口径：角色 / 要求 / 工具 / 原则）：所有 agent 的系统提示词都按这四段组织 ——

| 段 | 文件 | 放什么 |
| --- | --- | --- |
| `# 角色` | `templates/<agent>.eta` | 它是谁 + **这个角色的边界**（如"没有绑定业务工具"） |
| `# 要求` | `partials/requirements.eta` | 交付与格式的硬要求（中文、结论先行、只依据工具返回值、多步任务先写清单） |
| `# 工具` | `partials/tools.eta` | 只渲染**实际授权**的清单（key + 标题）与**每个工具自己的 `description`** —— 工具的适用场景 / 边界 / 纪律**只写一处**（`AgentTool.description`），模板里不再重复一遍（两处写必然漂移；那份说明同时也是模型选工具时看到的定义） |
| `# 原则` | `partials/principles.eta` | 行为取向（尽量用工具把事办成、任务宽泛先动手、未知与失败如实说） |

首轮注入的 `# 运行环境`（`partials/environment.eta`）跟在最后，也算一段。

#### 3.15.3 安全边界（**如实记录，不假装这是沙箱**）

命令以**服务进程的身份与权限**运行 —— 能读写该身份能读写的一切。本轮的取舍是"把可控的部分做死"：

| 控制点 | 落法 |
| --- | --- |
| 开关 | `AGENT_COMMAND_ENABLED`（**默认 `false`**，自用 / 内网确需时显式打开）。关掉时工具**仍在**（装配期工具池必须非空），每次调用返回"已被关闭"的结论 —— 模型能理解并改口 |
| 目录边界 | `AGENT_COMMAND_WORK_DIR`（默认服务进程工作目录）。agent 传入的 `cwd` 必须落在其内，越界**拒绝并说明边界**（不静默夹回）；判边界用 `path.relative`，天然处理 `..` 逃逸与 Windows 大小写差异。**根目录是 AI 的 workspace**：启动时与每次执行前都 `mkdir -p` 兜底（根目录被删后新建会话里的命令不会全部因 cwd 不存在而失败；建不出来只记错误，不拦启动）。**注意：它只约束 `cwd`，不约束命令读什么** —— 命令里的 `..` / 绝对路径 / 脚本里的 `fs` 仍能读到工作目录之外；真正的隔离只能靠容器 / 低权限用户 / 只读挂载 |
| 时长上限 | `AGENT_COMMAND_TIMEOUT_MS`（默认 15s）：它**既是默认值也是硬上限** —— 模型传更小听它的，传更大一律夹到这里 |
| 输出上限 | `AGENT_COMMAND_MAX_OUTPUT_BYTES`（默认 64KB / 每条流）：超出即截断并终止命令 |
| 停止 | 运行时信封的 `abortSignal`（与"停止整棵树"同一口径） |
| 审计 | 完整入参出参落时间线（`tool-call` / `tool-result`，不裁剪）+ 每次执行一条 `ai.command.executed` info 日志 |
| 已知差异 | 中文 Windows 的 `cmd.exe` 输出按 UTF-8 解码可能乱码 —— **如实暴露**（乱码在 stdout 里看得见），不静默转码猜测 |

要做强隔离（不可信用户 + 对外服务）得把执行放进容器 / 沙箱，那是另一件事，本模块不假装做到。

#### 3.15.4 运行环境注入（操作系统 + 当前时间）

- **注入位置**：系统提示词的末尾（"系统指令告知"的字面落实）。渲染走模板
  `prompts/templates/partials/environment.eta`（提示词文本只走引擎的硬约定不破），
  数据由 `prompts/environment.ts` 组装：平台画像来自 kits 的 `describePlatform`，
  时间用 `Intl` 出「2026年9月30日星期三 17:55:00（Asia/Shanghai，UTC+08:00）」。
- **只在会话第一轮注入**（`conversations.turnCount === 0`）：系统提示词是整段请求的**前缀**，
  每轮塞一个新时间戳会让提供方的前缀缓存每轮失效（本工程专门统计缓存命中，不能自己打掉它）。
  需要精确时间时模型用 `bash` 自己取 —— 这正是两个需求互相咬合的地方。
- **取环境信息不依赖平台专属命令**：`uname` / `ver` 只在部分系统存在，故一律走 `node:os`
  （`process.platform` / `os.release()` / `os.arch()`）；`resolveShell` 按平台给
  `cmd.exe`（Windows）/ `/bin/sh`（POSIX），与 `execa` 的默认行为一致。
- **子 agent 不注入**：它的提示词由主 agent 现写（§3.14.2），`request_snapshot` 里要保持
  "父写的那份"的原样；需要环境信息由父写进它的提示词。

#### 3.15.5 配置项（app-config 的 `agent` 命名空间 → `.env`）

```bash
AGENT_COMMAND_ENABLED=false           # 默认关闭；自用 / 内网确需时显式改 true
AGENT_COMMAND_TIMEOUT_MS=15000        # 单条命令的时长默认值与硬上限
AGENT_COMMAND_MAX_OUTPUT_BYTES=65536  # 每条流（stdout / stderr）的输出上限
AGENT_COMMAND_WORK_DIR=               # 缺省 = 服务进程工作目录（启动 / 执行前自动创建）
```

#### 3.15.6 本轮改动面（自查用）

| 动作 | 对象 |
| --- | --- |
| 新增 | kits `foundation/command/{command.runner,command.platform,command.module,index}`、`ai/tools/bash.tool.ts`、`ai/core/prompts/environment.ts`、`ai/core/prompts/templates/partials/environment.eta` |
| 改动 | `tool-keys`（`runCommand`）、`assistant.agent`（授权）、提示词片段（用法与确认纪律，现落在 `partials/tools.eta`）、`ai.mastra`（`instructions` 改动态参数：用信封里的渲染全文）、`core/envelope`（信封加 `systemPrompt`）、`chat.service`（注入 `PROMPT_ENGINE` + 渲染 + 落快照）、`ai.module`（`CommandCore` + `PROMPT_ENGINE` provider）、`app-config`（`command*`）、`root.module`（`CommandModule`）、依赖 `execa` |
| 测试 | kits 10 项（正常 / 非零退出 / 超时 / 孙进程不拖死 / 截断 / cwd / 起不来 / 中止 / 三端画像）；server：环境片段 3 项 + 命令策略 5 项（开关 / 目录越界 / 目录内 / 时长夹紧）+ e2e 两条（真跑一条跨平台命令并完整落库；首轮注入且第二轮不再注入） |

### 3.16 附件（多模态输入）：只传存储 key，按类型分别喂给模型（**本轮新增，以此为准**）

#### 3.16.1 主要矛盾：2MB 的附件进不了 2mb 的请求体

服务端请求体上限 **2mb**（`apps/server/src/main.ts` 的 `useBodyParser`），而附件上限也是 2MB ——
一旦把文件内联进请求体，光是 base64 膨胀（+33%）就必然 413。所以链路定成：

```
前端 --预签名直传--> 对象存储 --只回 key--> 随消息提交 --服务端按 key 取回--> 转成模型内容
```

于是请求体大小与文件大小无关，时间线落库也只存元数据（**绝不把 base64 写进 `timelines.payload`**：
那会把审计表撑变形，而 payload 的口径是"一律不裁剪"，见 §4.6）。

#### 3.16.1.1 一份附件在三个地方各存什么（账目要清）

| 位置 | 存什么 | 为什么不存另一种 |
| --- | --- | --- |
| **对象存储**（`ObjectStorage`） | **文件本体**：前端经预签名 URL 直传（`use-attachments-upload.ts` 的 md5 key + `PUT`） | 只有它适合放二进制；放请求体必然撞 2mb 上限 |
| **请求体**（`AgentChatSchema.attachments`） | 只传 `{key, filename, mediaType, bytes}` | 与文件大小无关（2MB 图 base64 后 +33% 必然 413） |
| **`timelines.payload`** | 同样的 `{key, filename, mediaType, bytes}`（`userMessagePayload`） | **绝不落 base64**：`runs` / `timelines` 是审计表，"一律不裁剪"的口径下塞几 MB 图片会把表撑变形、把时间线分页拖慢；要展示再按 key 解析 |
| 模型输入 | 图片 → `image` part 的 data URL；文本类 → 内联文本；**PDF → 本地抽出文字层后内联成文本** | 不依赖"供应商能不能访问我们的对象存储"（预签名地址对内网不可达、会过期）；PDF 也不依赖供应商的文件通道（见下） |

**键的命名空间**：前台用户上传时服务端把 key 改写成 `user/<自己的 id>/<basename>`
（`resolveUploadKey` 清掉 `/` 与 `..`，防目录穿越与伪造他人前缀）；管理员后台上传不加前缀。

**归属校验（2026-10-07 补的漏洞）**：附件链路的 key 是**客户端给的**——不校验的话，前台用户把 key
写成 `user/<别人的 id>/x.png`，服务端就会把别人的文件读出来喂给模型（内容还会经模型回显）。
所以读对象**之前**先过 `AttachmentKeyPolicy.assertOwned`（`ai/runtime/attachment-key.ts`）：
前台用户必须落在自己的前缀内，管理员与鉴权关闭按现状放行（与 `StorageController` 同一姿态）。
越权抛 3202（`StorageKeyForbidden`），**不静默跳过那条附件** —— 跳过会让模型对着看不见的附件胡说。
`ai-chat-attachment.test.ts` 的 6 条用例钉住它，其中包括"越权时**根本没调用** `getObject`"。

#### 3.16.2 三类附件、三种喂法（`ChatAttachmentService`）

| 类型 | 怎么给模型 | 为什么 |
| --- | --- | --- |
| 图片（png/jpeg/webp/gif） | `image` part，内容用 **data URL** | 不依赖"供应商能不能访问我们的存储"：预签名地址对内网对象存储不可达，且会过期 |
| 文本类（txt/md/csv 及常见代码后缀） | 取回后**内联成文本** part（≤2 万字符，截断明示） | 模型看的就是文字，没必要走文件通道；一份 2MB 文本吃掉整轮预算不划算 |
| **PDF（有文字层）** | **本地抽文字 → 内联成 `text` part** | **DeepSeek 的文件通道只支持图片格式**（实测 `/chat/completions` 发 PDF 直接 `400`：`file is valid and has one of the following formats: webp, png, jpeg, and gif`；Files API 文档同）。而 `@ai-sdk/deepseek` 对非图片 file part 只记一条警告后**静默丢掉**（运行照样"成功"）——所以 PDF 必须自己抽文字，那条路对任何模型都有效 |
| PDF（扫描件 / 无文字层） | 退回 `file` part | 抽不出文字只能交给模型；此时**才**要求模型的"文件输入"能力，不支持就当场抛错说清 |

**判据只看我们自己的**（媒体类型 + 文件名后缀）：前端传来的 `mediaType` 是"用户设备认为的类型"，
不可当可信输入（浏览器常把 `.md` 报成 `application/octet-stream`，所以有后缀兜底）。

**读不回来就抛错（3311）终止这一轮**：静默丢掉用户发的东西，会让模型对着一份看不见的附件胡说，
比直接报错难查得多。

#### 3.16.2.1 最坑的一个：**durable（崩溃恢复）开启时图片被 Mastra 压平**（已修，改之前必读）

**症状**：图片一路正确（前端传 key、时间线落元数据、服务端按 key 取回、组装成 `image` part、
`built.messages` 末条 content 是 `["text","image"]`），但模型回答"我没收到图片"。
看现象像"模型不支持读图"，实际与模型能力**无关**。

**根因**：`@mastra/core@1.69.0` 在 **`durable: true`**（可恢复执行，线上默认开启，见 §3.3）下，
会把多模态消息的 `content` **压平成纯字符串**，图片被静默丢掉：

| 形态（同一张图、同一个官方适配器） | 出站请求 |
| --- | --- |
| ❌ `durable: true`（**线上默认**） | **156 字节**，`content: "看图"` —— 图没了 |
| ✅ `durable: false` | 含 `image_url` 的正常请求 |
| ✅ `durable: true` + **`@mastra/core@1.75.0`** | 含 `image_url` 的正常请求（**上游已修**） |

**修法**：把 `@mastra/core` 从 `1.69.0` 升到 **`1.75.0`**（`@mastra/ai-sdk` 同步到 `1.10.6`）。
我们这边的适配代码**没有错**（模型实例、消息组装、`image` part 都是对的），所以不要去改它们。

**回归防线**：`ai-mastra-contract.test.ts` 的"durable 下的多模态"——断言 durable agent 的出站请求里
`user.content` 是**part 数组**且含 `image_url`（压平时是纯字符串）。
**这条必须走 `durable: true`**：不传 durable 时这个 bug 根本不出现（早先的 e2e 用 mock 且非 durable，
所以完全看不见它 —— 这也是它藏了这么久的原因）。

**排查教训（比 bug 本身值钱）**：
1. 逐环节证明"每个环节都没问题"**不等于**定位了问题 —— 必须让**真实那条路径**跑一次并看**出站请求**；
2. 我一直漏了 `durable` 这个变量：实验里用的都是 `new Agent()`（默认非 durable），
   而生产是 `createMastraAgent({ durable: true })`。**"实验环境与生产不一致"是排查中最贵的坑**；
3. 早期一版 A/B 得出了"动态 `model` 参数会导致压平"的**错误结论**并写进了注释 ——
   那次对照没有控制 durable 变量。结论要能复现，**A/B 必须只改一个变量**。

#### 3.16.3 两个自己发现的坑（都已修，写在代码注释里）

1. **附件的 token 成本原先在 `buildInput` 之后才注入** → 裁剪决策看不见它。
   一张图按 data URL 长度折算能得出几十万 token 的假结论，于是每次带图都触发一次
   **要真花钱**的压缩，或者直接抛 3307（不硬塞）。现在由调用方算好成本、经
   `BuildContextInput.extraInputTokens` 传进去，**估算与阈值判断都算上**，快照也如实体现在
   `estimatedInputTokens` 里（对模型可以省，对审计必须诚实 —— 与 §3.9 同一姿态）。
   估算规则本身在 `@repo/shared` 的 `estimateContentTokens`（媒体 part 按固定成本 1500，
   与 data URL 长度无关）。
2. **`withUserContent` 在"末条不是 user 消息"时静默返回** → 附件被悄悄丢掉。
   改为抛错：这是内部不变量，靠"今天正好成立"迟早出事，而症状（模型看不见我发的图）离原因很远。

#### 3.16.4 前端口径

- **发送键是 ⌘/Ctrl + Enter**（`PromptInputTextarea` 的 `submitOn="mod+enter"`，默认仍是上游的 Enter 语义）：
  长文本场景下"回车即发送"太容易误发；输入法组字期间的回车不触发提交。
- **粘贴上传**由 ai-elements 的 `PromptInput` 自带（`onPaste` → 附件状态），加上输入框上方的
  待发附件条（缩略图 / 文件名 / 大小 / "内容会读给模型"）。
- **校验刻意不交给 `maxFileSize` / `accept`**：`accept` 只提示文件选择框（粘贴不过它），
  `maxFileSize` 是"一个超限就把整批丢掉"的粗粒度行为。改为**提交前逐文件预检**：
  有不合格的就整轮不发，并逐个说清"哪个文件、为什么、多大"（上限常量与 `AgentChatSchema` 同源）。
- **提交时序**：先把附件传完再 `sendMessage`（失败即不发这一轮，输入框里的文字与附件都留着）——
  先发后传会让用户得到一段"对不存在的附件评头论足"的回复。附件 key 随 `sendMessage` 的
  metadata 交给 transport（key 只有上传那一步才知道，file part 里装的是预览地址）。
- **历史回看**：从 `timelines.payload.attachments` 重建 file part。**只发图不打字的消息此前会整条消失**
  （早先的重建判据是"有文字"），现在判据是"有文字或有附件"。

#### 3.16.5 多模态能力是**模型实体的独立字段**（本轮重构，以此为准）

**主要矛盾**：给一个收不了图的模型发图，最坏的结果不是报错，而是上游**静默忽略** ——
用户以为模型看过图了，其实它什么也没看到，接着基于幻觉回答。所以"这个模型能收什么输入"
必须是一份**显式、可查、能人工纠正**的事实。

**上一版做错了什么**：把它塞进 `ai_models.capabilities` 这个 jsonb 的约定键（`vision` / `file`）。
那一列的语义是"**供应商给什么存什么**"，同步会整列覆盖 —— 于是同步时得写代码特判保住人工声明，
前端要猜字段名，语义上也不对（它不是供应商的原始数据，是我们的模型画像）。

**业界怎么做**（本节的事实依据）：

| | OpenRouter（[Models API 标准](https://openrouter.ai/docs/guides/overview/models)） | LiteLLM（[model_prices_and_context_window.json](https://docs.litellm.ai/docs/provider_registration/add_model_pricing)） |
| --- | --- | --- |
| 形态 | `architecture.input_modalities: ["text","image","file"]` + `output_modalities`（实测 465 个模型，取值 `text` / `image` / `file` / `audio` / `video`） | 扁平布尔：`supports_vision`（2234/4485）、`supports_pdf_input`（1015）、`supports_audio_input`（746）、`supports_video_input`（126），另有 `max_images_per_prompt` / `max_pdf_size_mb` 这类上限位 |
| 类型 | `architecture.modality` 人类可读串 | `mode`（chat / embedding / image_generation…，4476/4485 都有） |

共识：**输入 / 输出模态是模型的一等属性**。我们取 **OpenRouter 的数组形态**（加一种模态不用改表，
将来对接 / 导出模型清单字段也对得上），并借 **LiteLLM 的 `mode`** 解决"选模型下拉里混进 embedding"。

**落地的三个字段**（`ai_models`）：

| 字段 | 含义 |
| --- | --- |
| `mode` | 模型类型（见 `AiModelMode`），默认 `chat`；agent 的可选模型**只列对话类**，`unknown` 照列 |
| `input_modalities` | 输入模态数组；取值见 `AiModality`（`text` / `image` / `file` / `audio` / `video`） |
| `output_modalities` | 输出模态数组（我们只做对话，实际基本是 `["text"]`） |

`capabilities` **保留但语义收窄**：它只是"供应商原始能力标记"的留存（排查用），判能力一律看模态字段。

**三态，不是两态**（`null` 与 `[]` 是两件事）：

| 值 | 含义 | 附件怎么办 |
| --- | --- | --- |
| `null` | **未声明**（供应商没给、人也没填） | **不拦**，只在会话页提醒"该模型未声明输入模态，图片 / 文件可能读不了" |
| `[]` | 明确声明"什么输入都不支持" | 拦 |
| `["text"]` | 明确只收文本 | 图片 / 文件拦下并说清是哪个文件 |

为什么未声明**不拦**：国内厂商的"列模型"接口普遍不给模态信息，硬按"不支持"处理会把真正的视觉模型
也误伤（用户粘了图却被告知不支持，而其实模型能看）。真不能收图时，服务端会明确报错（3312），
比前端瞎猜强。

**供应商给了就落库**（`provider-adapters.ts` 的 `parseModalities` / `parseMode`，认过的形态）：
OpenRouter 的 `architecture.*`、LiteLLM 的 `supports_vision` / `supports_pdf_input` 等布尔位、
顶层 `input_modalities` / `modalities` / `input_types`、以及 `capabilities` 里的词
（认 `vision` → `image`、`pdf` → `file` 这类同义词）。**都认不出就是 `null`，绝不编造** ——
包括不把"输出"默认成 `["text"]`：清单里混着 embedding / 图像生成模型，替它们声明输出是编造。

**同步不覆盖人工填的模态**：`upsertSyncedModel` 里 `input.inputModalities ?? existing.inputModalities`
（输出同理）—— 供应商没给（`null`）时保留库里的值。上一版靠"合并 capabilities"来实现同一目的，
现在字段独立了，一条 `??` 就够（`ai-model-module.test.ts` 的 ⑤c 钉住）。

**三层校验，判据同一份**（`attachmentCapabilityIssue`，输入是模态数组）：

1. **前端预检**（提交前）：只判图片（要 `image`）—— PDF 与文本类我们都能本地转成文字，不需要模型有对应能力；明确声明不支持就**整轮不发**并逐条说明；
   清单还没到手（`undefined`）或模型未声明（`null`）都**不拦**（交给服务端）；
2. **服务端权威校验**（`ChatAttachmentService.assertSupported`）：前端可以绕过，所以必须再判一次 ——
   明确不支持抛 3312；未声明只留一条 warn（便于排障"用户发图后模型说看不到"）；
3. **读不出来时的降级**（`readAttachment` 的顺序，有讲究）：
   图片 → `image` part；**PDF → 先本地抽文字层（`extractPdfText`）**，抽到就内联成文本，
   抽不到（扫描件 / 加密）才退回 `file` part —— 退回时**才**判模型的"文件输入"能力，不支持就抛错；
   这一步**必须排在"当文本试"之前**，否则 PDF 里的 `%PDF-1.4` / 对象字典那段可读 ASCII
   会让它被当成乱码内联进提示词，白烧一窗口 token；
   认不出类型的 → **先当文本试**（读得出来就内联，任何模型都能用）；都不行 → 明确拒绝。

**界面**：模型选择器的每一项与触发按钮上标「图」/「文件」徽标（选之前就知道）；
四项都不支持时上传按钮禁用并说明；**未声明**时给一句提醒（不拦）。

**后台「模型管理」**：模型类型用字典下拉（`DictSelect` + `AiModelMode`），输入 / 输出模态用
复选框多选（`ModalityPicker`），并显示当前是"未声明"还是"明确声明了哪几项"，可一键撤回未声明。

**错误码**：3312（`ModelCapabilityMismatch`）。

#### 3.16.6 已知取舍（写下来，免得日后当 bug）

1. **历史轮次的图片不回灌上下文**：`toSegments` 只读 `payload.text`，所以多轮图片对话从第二轮起
   模型看不到上一轮的图。回灌要么每次组装都去取对象（慢、且要把 data URL 塞进历史），
   要么另建缓存 —— 这一轮不做，界面上也没承诺"它能记住图"。
2. **模态靠"供应商给的 + 人工补的"**：供应商不给时（国内厂商普遍如此）需要人在后台声明。
   刻意**不内置一份"哪些模型支持视觉"的清单**：那是会过期的外部知识，猜错的代价是用户的图被静默丢掉；
   认不出就诚实地写"未声明"。
3. **请求体上限仍是 2mb**：单个附件 2MB 走存储没问题，但若日后要把文件内联进请求体，
   得先动这个上限。

#### 3.16.7 本轮改动面（自查用）

| 动作 | 对象 |
| --- | --- |
| 新增 | `ai/runtime/chat-attachment.service.ts`、`shared/utils/token.utils.ts`、`shared/dicts/ai-capability.dict.ts`、**`shared/dicts/ai-modality.dict.ts`**、`@repo/ui` 的 `components/prompt-attachments.tsx`、admin 的 `attachment-utils.ts` / `use-attachments-upload.ts` / `use-available-models.ts` |
| 改动 | `agent.schema`（`ChatAttachmentSchema` + 上限常量 + `AgentChatSchema` 的 `attachments` 与"文字与附件不能同时为空"）、**`ai-model-entity` + `ai-model.schema`（`mode` / `input_modalities` / `output_modalities` 三个字段 + 迁移）**、`provider-adapters`（模态与类型解析）、`ai-model.repository`（同步不覆盖人工填的模态）、`ai-model.service`（可选模型按类型过滤）、`chat.service`（注入附件服务 + `buildContext` 先取内容再组装 + 附件落库 + **每轮显式传模型实例**）、**`mastra/agent.adapter.ts`（`toMastraModelInstance`）与 `runtime/agent-runner.ts`（子 agent 同样显式传实例）**、`context.service`（`extraInputTokens` 参与估算与阈值）、`core/envelope` + `RuntimeModel`（带能力）、`core/errors` + `app-error-code`（3311 / 3312）、`ai.module` / `runtime/index`（登记）、`prompt-input.tsx`（`submitOn` / `PromptInputFilePart.rawFile` / `PromptInputAttachmentButton`）、admin 会话页（点击上传 + 能力预检 + 提交前上传 + `prepareSendMessagesRequest` 带附件 + 历史重建）、admin 模型页（能力三态选择器） |
| 测试 | server：**带附件的对话端到端 1 项**（只传 key / 时间线不落 base64 / 图片真到模型 / 命名不带图）、**附件归属校验 6 项**、**模态与类型解析 11 项**、**模型模块（含同步不覆盖人工模态、按类型过滤）19 项**、附件服务 20 项（三类喂法 / 截断明示 / 取不回抛错 / 能力校验 / 文本降级 / `withUserContent` 不静默）、上下文附件成本 1 项、模型同步保留人工能力 2 项；shared：token 估算 6 项 + 入参校验 8 项 + 能力判据 17 项；admin：前端预检 18 项 + 历史重建附件 3 项 |

## 4. 记忆与落库（调研已回，本节定稿）

### 4.1 配置形状与职责边界

```ts
// 记忆实例必须来自 @mastra/memory（@mastra/core/memory 只有抽象类与类型）
const memory = new Memory({ storage, vector?, embedder?, options: { ... } })

// agent 调用时按「会话 + 归属人」传入（旧的顶层 threadId / resourceId 已废弃）
await agent.stream(messages, { memory: { thread: conversationId, resource: userId } })
```

- `thread` = **会话**（一个对话窗口），`resource` = **归属主体**（我们用登录用户 id）；
- 不传 memory → 不落库、历史不进上下文；传了但 agent 未挂 memory 只告警；
  Memory 没有 storage 时 `get storage()` 直接抛错 —— 即**「落库」这件事全靠 Memory + storage**。

### 4.2 落库真相（实测 DDL，需求 C 的答案）

| 表 | 内容 |
| --- | --- |
| `mastra_messages` | `content` 是 `JSON.stringify` 后的 `MastraMessageContentV2`：**parts 结构完整落库**，`reasoning`（`{type:'reasoning', text, providerMetadata}`）、`tool-invocation`、`step-start`、`source-*`、`error`、`data-*` 都在里面 |
| `mastra_threads` | 会话（`resourceId` / `title` / `metadata` JSONB） |
| `mastra_resources` | 归属主体（`workingMemory` TEXT + `metadata`） |
| `mastra_observational_memory` | 观察式记忆（启用时） |

**结论：需求 C 的「推理过程入库」由 Mastra 原生满足，不需要我们另建推理表**；
`sendReasoning` 只影响流式转 UI，与存储无关（存的一直是全量 part）。

读历史给前端（官方做法）：

```ts
const memory = await agent.getMemory()
const { messages } = await memory.recall({ threadId, perPage: 50 })
return toAISdkMessages(messages, { version: 'v6' }) // 从 '@mastra/ai-sdk/ui' 导入
```

⚠️ 1.69.0 **没有** `memory.query` / `memory.getMessages`（旧 API 已被 `recall()` 取代）；
`@mastra/core` 也不导出任何 `toAISdk*`，转换函数在 `@mastra/ai-sdk/ui`。

### 4.3 记忆：本轮不做（决定），下表留作备查

**决定：记忆先不做** —— 不引入 `@mastra/memory`、不建记忆表、不配 working memory / semantic recall。

- 这**连带砍掉一半工作量**：storage adapter 不再需要 `memory` domain（原 10 个方法），
  **只剩 `workflows` 的 9 个方法**（durable agent 的快照）；
- 对话要能用，仍需要「把最近若干条消息带进上下文」—— 这不算记忆功能，我们**自己从 `timelines` 取**：
  按 token 预算裁剪 + 超阈值时压缩成摘要，完整设计与留证要求见 **§3.9**；
- 长期记忆、工作记忆、向量召回、观察式记忆**全部推迟**，将来若要，再回到下面这张表做取舍。

| 形态 | 配置 | 存哪 | 需不需要向量库 |
| --- | --- | --- | --- |
| 短期（上下文窗口） | `lastMessages`（默认 10，已废弃）或 `messageHistory: { maxTokens }`（超预算释放 25%） | 不额外存，运行时从消息表取 | 不需要 |
| 工作记忆（结构化事实） | `workingMemory: { enabled, scope: 'resource'\|'thread', template?\|schema? }` | resource scope → `mastra_resources.workingMemory`；thread scope → `mastra_threads.metadata.workingMemory` | **不需要** |
| 长期语义召回 | `semanticRecall: { topK, messageRange, scope }` | 向量表 `memory_messages`（pgvector） | **需要 vector + embedder** |
| 观察式记忆 | `options.observationalMemory`（`@mastra/pg` 明确支持，官方文档推荐） | `mastra_observational_memory` | 不需要 |

两个必须知道的硬事实：

1. **`semanticRecall` 没配 vector/embedder 会直接构造失败**（`Semantic recall requires a vector store…`），
   不是静默降级 —— 所以「要不要向量」是一个**启动期就决定**的开关；
2. **向量方案用 `@mastra/pg` 自带的 `PgVector`**（npm 上**没有** `@mastra/pgvector` 这个包）：
   它会 `CREATE EXTENSION IF NOT EXISTS vector`，索引在**首次语义读写时懒建** →
   **运行时数据库账号需要 DDL 权限**（这一点会影响生产环境的最小权限设计）。

### 4.4 存储适配层与我们的表（**决定：不用官方表**）

不做"Mastra 建表 + 我们另建业务表"的双轨（那会双写、会不一致），
而是**自己实现 Mastra 的 storage adapter**，表全部由我们设计：

| 要做的事 | 具体 |
| --- | --- |
| 存储适配器 | `MastraCompositeStore` 子类 + **一个 domain：`workflows`（9 个抽象方法**：快照持久化/读取/运行列表/查删 + 并发能力声明）。原 `memory` domain（10 个方法）随"记忆不做"一起取消 |
| 表 | TypeORM 实体 + 迁移，随工程走（可评审、可演进、和业务表同一套迁移体系）；不需要 `@mastra/pg`，因此**不存在**自动建表 / `exportSchemas` / 运行时 DDL 权限这一串问题 |
| 消息与推理的落库 | **我们自己的服务写**（从 UI 消息流逐 part 落 `timelines`），不经 Mastra Memory |
| 上下文组装 | **我们自己拼**（从 `timelines` 取最近 N 条 → `ModelMessage[]`），不依赖 Mastra Memory 的 `recall` |
| 业务查询 | 走**我们自己的 repository 与接口**（会话列表、消息历史、推理过程），不依赖 Mastra 的查询 API |

**必须说清的边界与长期成本**：

1. workflow 快照的**内容**是 Mastra 的内部状态：我们存 JSONB、不解析、不做业务查询；我们掌控的是
   容器表结构与读写路径；
2. 升级 Mastra 时**要跟着它的 storage 接口演进补方法** —— 这是自建表的固有代价；
   缓解办法是把它收在一个固定的适配层里（不是散落各处），并在适配层写清"接口来自哪个版本"；
3. ⚠️ **向量检索是这条路上唯一的"例外开口"**：`semanticRecall` 需要一个 vector store，
   而官方 `PgVector` 会自己建表（`memory_messages`）—— 与"不用官方表"冲突。
   所以：**本轮不开 `semanticRecall`**（用工作记忆 + 观察式记忆承载长期记忆）；
   将来若要向量检索，再决定是自建 vector adapter 还是接受一张官方表。

### 4.5 多租户、访问控制与删除

**删除规则（已拍板）**

| 对象 | 能否删 | 方式 |
| --- | --- | --- |
| 会话（`conversations`） | 能 | **只能软删**（`deleted_at` + `deleted_by`），走 kits 的 `safeDelete`（它类型上要求 `AuditEntity`，正好强制我们把审计列带上） |
| 运行记录（`runs`） | **不能** | 无删除接口；只追加 |
| 时间线（`timelines`） | **不能** | 无删除接口；只追加（唯一的"改"是恢复重跑时的 upsert，见 §3.9） |

- 软删语义：会话从列表与业务接口消失（再访问 → 3304），**数据仍在库里**；
  admin 审计查询带 `includeDeleted` 开关（默认不显示），复盘不受影响；
- **软删前先结束在跑的运行**（有 `pending` / `running` 的 run → 先 `canceled`），
  否则"用户看不到了、模型还在跑、钱还在烧"；
- 会话 id 是 nanoid、不复用，因此软删后重开新会话不会与旧数据混淆；
- 保留期：默认**永久**（§3.8 第 8 项）；若将来要清理，清理动作本身要留痕。


- `resource: userId` + `thread: conversationId`，服务端从鉴权上下文取 userId，**不接受前端传 owner**；
- `recall({ threadId, resourceId })` 内部会校验归属，不匹配直接抛
  `Thread with id X is for resource with id Y but resource Z was queried.`；
- ⚠️ 但官方明文：**Memory 不做访问控制**，所以「这个会话是不是当前用户的」必须我们在
  边界先校验（`getThreadById({ threadId, resourceId })` 或走自有会话表），不能只靠 recall 抛错兜底。

### 4.6 数据模型：三张表（拍板：`conversations` / `timelines` / `runs`）

三张表**同时承担两个角色**：业务事实的来源（我们自己的 repository 查询）
+ Mastra 存储接口的后端（adapter 读写同一批表）→ 因此**没有双写、没有第二份真相**。

实体一律继承 `BaseEntity`（自动 `id` nanoid(20) / `created_at` / `updated_at` / `deleted_at` 软删）、
表名复数、列名 snake_case、索引显式命名 —— 与工程既有实体同一套约定。

**① `conversations`（会话 = Mastra 的 thread）**

| 列 | 类型 | 说明 |
| --- | --- | --- |
| `user_id` | varchar(20) | 归属用户（= Mastra 的 `resource`；服务端从鉴权上下文取，不接受前端传） |
| `agent_key` | varchar(64) | 用哪个 agent（默认 `assistant`） |
| `title` | text | 会话标题（首条消息摘要 / 模型生成 / 用户改） |
| `status` | varchar(20) | 字典 `ConversationStatus`：`active` / `archived` |
| `last_active_at` | timestamp(3) | 最后活动时间（列表排序依据，避免按 `updated_at` 排序被标题修改污染） |
| `turn_count` | int (default 0) | **轮数**：该会话已完成的问答轮数（列表页直接读，不必聚合 `runs`） |
| `total_tokens` | bigint (default 0) | 该会话累计 token（同上，冗余以省聚合） |
| `metadata` | jsonb | 扩展位；Mastra `thread.metadata` 原样保留在此 |

索引：`idx_conversation_user_active (user_id, last_active_at)`。
无唯一约束（标题可重复）。

**② `runs`（一次运行 = 一次"用户发言 → agent 跑完"）**

| 列 | 类型 | 说明 |
| --- | --- | --- |
| `conversation_id` | varchar(20) | 所属会话 |
| `parent_run_id` | varchar(20) null | **父 run**（子 agent 用；`NULL` = 根 run = 一轮问答。**逻辑引用，无物理外键**） |
| `depth` | int (default 0) | 深度：根 0、子 agent 1（当前工具面已保证不超过 1，配置位留给将来） |
| `tool_call_id` | varchar(64) null | 子 run 专用：**父那次工具调用的 id**（幂等键的一半，见 §3.14.6） |
| `agent_key` | varchar(64) | 本次用哪个 agent（会话可换 agent，以 run 为准）；子 agent 记 `sub:<name>`（不在注册表，这是有意的） |
| `status` | varchar(20) | 字典 `RunStatus`：`pending` / `running` / `succeeded` / `failed` / `interrupted` / `canceled` |
| `engine_run_id` | varchar(64) null | **Mastra durable agent 的 runId**（`observe` / `recover` 用；唯一索引） |
| `triggered_by` | varchar(20) null | 发起人（= 登录用户 id；审计用） |
| `request_id` | varchar(64) null | 发起该轮的 HTTP `X-Request-Id`（把审计记录与日志 / 告警串起来） |
| `request_snapshot` | jsonb null | **送给模型的输入快照**（模型 / 参数 / agentRevision / 工具与技能清单 / 上下文裁剪与压缩记录，见 §3.9）—— 复盘的输入侧证据 |
| `active_stream_id` | varchar(64) null | 续传用（对应 activeStreamId；结束时清空，见 §5.3） |
| `snapshot` | jsonb null | Mastra workflow 快照（adapter 读写，**我们不解析、不做业务查询**） |
| `error_code` | varchar(32) null | 失败错误码（机器可读，见 §3.7） |
| `error_stage` | varchar(20) null | 失败发生在哪一环：`model` / `tool` / `stream` / `recovery` / `timeout` |
| `error_message` | text null | 失败原因（中文，给用户看） |
| `error_detail` | jsonb null | 上游原文（**全量保留**，仅密钥掩码），给排障看 |
| `recovery_count` | int (default 0) | 崩溃恢复的重跑次数（**上限 1**，防止无限重跑烧钱） |
| `usage` | jsonb null | **本轮消耗汇总**（见 §4.7）：`{ inputTokens, outputTokens, totalTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens }`；步级明细在 `timelines` 的 `step` 行，不在这里重复 |
| `step_count` | int (default 0) | **步数**：本次运行内的模型调用次数（= `steps.length`，上限由 `AGENT_MAX_STEPS` 控制） |
| `tool_call_count` | int (default 0) | 本次运行的工具调用次数 |
| `duration_ms` / `first_token_ms` | int null | 总耗时 / 首字延迟（体验指标；首字延迟只在流式时有意义） |
| `started_at` / `finished_at` / `heartbeat_at` | timestamp(3) null | `heartbeat_at` 是**恢复判定**的依据（进程死没死、要不要重放） |

索引：`idx_run_conversation_created (conversation_id, created_at)`、`idx_run_status (status)`、
唯一索引 `uk_run_engine_run_id (engine_run_id)`；
**并发控制用部分唯一索引**：`uk_run_active_conversation (conversation_id) WHERE parent_run_id IS NULL AND status IN ('pending','running')`
—— 同一会话同时只允许**一次进行中的根运行**，第二个请求直接被数据库挡住（转成 3306，见 §3.7），
不靠应用层"先查再写"的竞态判断。
**`parent_run_id IS NULL` 这一条是子 agent 的硬前提**：子 run 与父 run 同时 running 是正常状态，
不加它子 agent 一跑就撞唯一键（§3.14.3）。
另：`idx_run_parent (parent_run_id)`（按父查子）、`uk_run_tool_call (parent_run_id, tool_call_id)`（幂等去重，部分索引：`WHERE tool_call_id IS NOT NULL`）。

**子 run 的查询入口（审计 / 复盘）**：`POST /agent/run/list { conversationId, page, size }`
一次拿到该会话的**全部运行**（含子 agent），字段带 `parentRunId` / `depth` / `toolCallId`，
前端据此拼父子树；同一个 `POST /agent/timeline/list` 也能按 `runId` 单独拉某个子 agent 的全过程。
没有"删除运行"这类接口 —— 运行与时间线是审计证据（§4.5）。

**③ `timelines`（时间线事件：消息 + 推理 + 工具 + 状态，一行一个 part）**

| 列 | 类型 | 说明 |
| --- | --- | --- |
| `conversation_id` | varchar(20) | 所属会话 |
| `run_id` | varchar(20) null | 属于哪次运行（用户消息也归属触发它的那次 run） |
| `message_id` | varchar(64) | 同一条消息的多个 part 共享（= AI SDK 的 message id） |
| `seq` | int | 会话内单调递增的序号（**渲染顺序的权威依据**，不依赖时间戳） |
| `attempt` | int (default 1) | 第几次尝试（崩溃恢复重跑时 +1；配合 `(run_id, tool_call_id)` 唯一约束做 upsert，避免时间线出现重复条目） |
| `role` | varchar(20) | `user` / `assistant` / `system` |
| `kind` | varchar(32) | 字典 `TimelineKind`：`text` / `reasoning` / `tool-call` / `tool-result` / `step` / `source` / `status` / `error` / **`summary`**（上下文压缩产物，见 §3.9）/ `system`（系统提示词快照） |
| `state` | varchar(20) null | 对齐 AI SDK part 的 state（`streaming` / `done` / `error`；工具另有七态） |
| `tool_key` | varchar(64) null | 工具行专用：工具 key（提为列而不是埋在 payload 里，便于直接查「哪个工具最慢 / 最常失败」） |
| `tool_call_id` | varchar(64) null | 工具行专用：本次工具调用的 id（把 `tool-call` 与 `tool-result` 两行配对；也是**幂等键**的一半，见 §3.4） |
| `started_at` | timestamp(3) null | **该事件的真实开始时间**（首个增量到达 / 工具开始执行）。注意它**不等于** `created_at` —— 我们是 part 完成时才落库的 |
| `finished_at` | timestamp(3) null | **该事件的结束时间**；为 null 表示仍在进行（流式中） |
| `duration_ms` | int null | **耗时**（冗余存，避免每次查都算；`text` 是生成耗时、工具行是执行耗时、`step` 行是该步总耗时） |
| `usage` | jsonb null | **该事件的用量**（`step` 行放这一步的 `LanguageModelUsage`；其余行留空） |
| `payload` | jsonb | **该 part 的原文**：文本 / **工具入参（完整）** / **工具出参（完整）** / source url / 错误 / **摘要正文（`kind='summary'` 时含 `text` + `coversSeqs` 等元信息）**；**一律不裁剪** |

索引：`idx_timeline_conversation_seq (conversation_id, seq)`、`idx_timeline_run_seq (run_id, seq)`、
`idx_timeline_message (message_id)`、`idx_timeline_tool (tool_key)`、
`idx_timeline_summary (conversation_id, seq) WHERE kind = 'summary'`（组装上下文时快速定位「最新一条摘要」）；
**工具调用去重**：部分唯一索引 `uk_timeline_tool_call (run_id, tool_call_id, kind) WHERE tool_call_id IS NOT NULL`
（**必须带 `kind`**：同一次调用落两行 —— `tool-call` 与 `tool-result` —— 二者共用同一个 `tool_call_id`）
—— 崩溃恢复重跑重新产出同一次工具调用时 **upsert 而不是插两行**（保住幂等键，审计也不被重复条目迷惑）。

**保真原则（硬要求：工具入参出参不得裁剪）**

- 工具调用落**两行**：`kind='tool-call'`（payload = `{ toolCallId, input }`）与
  `kind='tool-result'`（payload = `{ toolCallId, output }`），**入参与出参都存完整原文** ——
  不裁字段、不截长度、不做"只留模型需要的字段"这类处理；
- 因此**工具本身也不裁剪返回值**：`execute` 直接把业务服务的完整结果交回去
  （工具只做参数翻译，不做"给模型看的瘦身版"）；
- **如实说代价**：完整出参会进模型上下文，token 成本高于裁剪版；这是保真的直接代价。
  将来若要控成本，正确做法是**另给模型一个摘要视图**（工具可选返回 `modelView`），
  而**不是**把落库也裁掉 —— 落库保真、模型视图可摘要，两件事分开；
- 唯一保留"处理"的地方是上游错误文本：只做**密钥掩码**，同样不截断（见 §3.7）。

**为什么时间线是"一行一个 part"而不是"一行一条消息"**：

- 需求要的是「消息列表 **+ 推理过程**」——推理天生是独立事件，工具调用与结果也各自成事件；
- **运行中可增量落库**：每个 part 完成即写一行，长回复不必等整条消息结束才落库；
- 前端"按时间线渲染"与库结构一一对应，刷新后能完整重建每一步；
- adapter 侧按 `message_id` 聚合即可还原 Mastra 消息（它本来就存 `parts` 数组），成本可控。

**落库时机（控制写放大）**：**part 完成时写一行**（`text-end` / `reasoning-end` / 工具输出可用 / step 结束），
写成时把该事件的 `started_at` / `finished_at` / `duration_ms` 一并落库；
**流式增量不落库**（运行中的增量在 Redis 流缓存里，供续传重放，见 §5.3）；
`status` / `error` 类事件即时落。

**为什么起止时间要单独列**（而不是靠 `created_at` / `updated_at`）：我们刻意在 part **完成时**才落库
（避免写放大），所以 `created_at` 是"落库时刻"、不是"事件开始时刻"；两者在长回复上可能差几十秒，
而"这一步/这个工具花了多久"必须用真实起止算，故显式存 `started_at` / `finished_at` / `duration_ms`。

**Mastra 存储接口 ↔ 我们的表（adapter 映射）**

| Mastra domain | 方法 | 落到 |
| --- | --- | --- |
| `memory` | `getThreadById` / `saveThread` / `updateThread` / `deleteThread` / `listThreads` | `conversations`（id = threadId，resourceId = user_id） |
| `memory` | `saveMessages` / `listMessages` / `listMessagesById` / `updateMessages` | `timelines`（按 `message_id` 聚合 / 拆分） |
| `workflows` | `persistWorkflowSnapshot` / `loadWorkflowSnapshot` / `listWorkflowRuns` / `getWorkflowRunById` / `deleteWorkflowRunById` / `updateWorkflowResults` / `updateWorkflowState` / `supportsConcurrentUpdates` | `runs`（`snapshot` 列 + `status` + 时间列；键 = `(agent_key, engine_run_id)`） |
| `memory` | 工作记忆的 resource 读写 | ⚠️ **三张表覆盖不到** —— 见下方待确认项 |

**三张表齐了**：会话（`conversations`）、运行与消耗（`runs`）、时间线（`timelines`）。

**硬规则：数据库绝对不能加物理外键**（`conversation_id` / `run_id` 只建索引，**不建 FK 约束**）。

理由：① 时间线是高写入量表，每行都做 FK 检查是白白的开销；
② 关系由应用层维护（写入顺序已由运行服务保证），查询靠索引，不靠约束；
③ 会话删除是软删，级联语义本来就不需要；
④ 全库统一（本仓既有表也是 0 个外键），不允许这里破例。

**代价**：可能出现"孤儿行"（引用不存在的会话）→ 由运行服务保证不发生；
若审计时发现，即视为数据缺陷（而不是靠数据库兜底）。
原方案的「第 4 张表（工作记忆位置）」**随"记忆先不做"取消**，本轮不再需要。
Mastra 存储接口里 `memory` domain 也不再实现（见 §4.4）。

### 4.7 消耗、轮数与步数：统计口径与位置（对齐你的问题）

**术语统一**（避免一轮/一步混用）：「**轮**」= 一次问答（多轮对话的那个轮）；
「**步**」= 一次模型调用（agent 循环的一步）；**「回合」这个词弃用**，两层各自只用一个词。

先说**口径**（三张表各管一段，避免前后端两套数）：

| 词 | 定义 | 权威来源 | 位置 |
| --- | --- | --- | --- |
| **轮（turn）** | 一次「用户发言 → agent 答完」= 一次问答（**只数根 run**：`parent_run_id IS NULL`；子 agent 不是一轮） | 我们的 `runs` 记录数 | `runs` 一行；`conversations.turn_count` 冗余累计 |
| **步（step）** | 一次**模型调用**（含它引发的工具往返；受 `AGENT_MAX_STEPS` 限流） | Mastra 流对象的 `steps` | `runs.step_count` |
| **工具调用** | 模型发出的工具调用次数（恢复重跑时会重复计，见下） | Mastra 流对象的 `toolCalls` | `runs.tool_call_count` |
| **消耗（token）** | 输入 / 输出 / 缓存读 / 缓存写 / 推理 token | Mastra 流对象的 `totalUsage`（= AI SDK 的 `LanguageModelUsage`） | `runs.usage.total` |

**取数 API 已核实**（`MastraModelOutput`，即 `agent.stream()` 的返回值上就有，不必自己数 part）：

```ts
const output = await agent.stream(messages, ...)
// 流管道写完之后（此时这些 promise 都已 resolve）
const usage = await output.totalUsage   // LanguageModelUsage
const steps = await output.steps        // LLMStepResult[]：每步含自己的 usage / toolCalls / toolResults
const toolCalls = await output.toolCalls
```

`LanguageModelUsage`（v6）字段：`inputTokens`、`outputTokens`、`totalTokens`、
`inputTokenDetails{ noCacheTokens, cacheReadTokens, cacheWriteTokens }`、
`outputTokenDetails{ textTokens, reasoningTokens }`（顶层的 `reasoningTokens` / `cachedInputTokens` 已废弃）。
**这些字段在各 provider 上都可能是 `undefined`** → 列定义允许 null，展示时缺失就显示"—"，不编造 0。

**步级明细落 `timelines`，不塞进 `runs`**（一处一份，不重复）：

- 每个模型调用步落一行 `kind = 'step'`：`usage` 放这一步的 `LanguageModelUsage`、
  `started_at` / `finished_at` / `duration_ms` 放这一步的起止与耗时；
- 工具行（`tool-call` / `tool-result`）自带执行耗时；
- `runs.usage` **只存本次运行的汇总**（`{ inputTokens, outputTokens, totalTokens, cacheReadTokens,
  cacheWriteTokens, reasoningTokens }`），供列表与详情页一次性读取，不做二次聚合；
- 于是"这一步花了多少 token / 哪个工具最慢"都能直接从时间线查到，且**不必为它多开一张表**。

**子 agent 的消耗怎么算**（§3.14.3，避免重复计费）：子 run 自己记一份完整 usage；
父 run 收尾时把子 run 的 usage 加总写进 `usage.subAgents`（父的合计**已含子**）；
会话累计只按**根 run** 的合计累加 → 全链路只算一次钱。

**收尾时机（与 §5.3 的 `waitUntil` 缺口是同一处）**：统计发生在**流写完之后**
（`pipeUIMessageStreamToResponse` 返回后读上面三个 promise → 更新 `runs`）。
若进程恰好在这个窗口挂掉：`runs.status` 停在 `running`、`heartbeat_at` 过期 →
由 boot 恢复流程处理（重放或标 `interrupted`），此时**消耗数据缺失就如实为空**，不估算回填。

**费用（金额）刻意不落库**：token 是事实，价格会变。展示层用 `tokenlens`（前端 `context` 组件本就用它）
按当前价目估算 USD，并注明"估算值"；将来真要财务对账，再单独做"价格快照表"，不污染 `runs`。

**冗余列必须原子累加**：`conversations.turn_count` / `total_tokens` 用
`UPDATE ... SET total_tokens = total_tokens + :delta`（SQL 内累加，不要读出来加完再写）——
同一会话可能并发跑多个 run，读改写会丢更新。

**前端展示**：会话列表读 `turn_count` / `total_tokens`（冗余列，不聚合）；
运行详情读 `runs` 的步数 / 工具调用数 / token 明细 / 耗时 / 首字延迟；
**每一步/每个工具的耗时与用量直接读 `timelines` 对应行**（时间线视图天然带这些列，不用额外聚合）；
用量与上下文占比交给 ai-elements 的 `context` 组件（`usedTokens` / `maxTokens` + `usage`）。

### 4.8 AI 模型模块：供应商表 + 模型表（配置类数据，与 agent 运行时解耦）

> **⚠️ 密钥存储口径已变更（2026-10-01）**：`ai_providers` 的密钥从 AES-GCM 密文改为**明文**
> （列 `api_key`），提示串 `hintOf` 在读取时派生；接口仍不回明文。理由与代价见
> `ai-agent-tool-engine.md` 的「实施记录」第 11 条。

> **落地状态（本轮）**：**只落地数据表**（`ai_providers` / `ai_models`，实体 + 迁移 + 对外模型数据结构，
> 迁移已应用）。CRUD / 同步接口 / 管理页按 §4.8.4 后续实现；错误码（§4.8.6）随模块一起加。

**要解决的问题**：模型与密钥目前只能靠环境变量（`MASTRA_MODEL` / `MASTRA_API_KEY` / `MASTRA_BASE_URL`）配置，
改一次要动部署；而且"这家供应商现在到底有哪些模型、窗口多大、支持不支持工具调用"只能靠人去查文档。
本模块把这两件事搬进库里，并**用供应商自己的接口把模型明细拉回来**。

#### 4.8.1 两张表（配置类，允许软删）

| 表 | 一行是什么 | 关键列 |
| --- | --- | --- |
| `ai_providers` | 一个模型供应商接入（哪家、什么地址、什么密钥、启用没） | `name`（唯一）/ `kind` / `base_url` / `api_key_cipher` + `api_key_hint` / `enabled` / `last_synced_at` / `last_sync_error` |
| `ai_models` | 该供应商的一个模型 | `provider_id` / `model_key` / `display_name` / `context_window` / `max_output_tokens` / `capabilities` / `source` / `enabled` / `last_seen_at` / `raw` |

三条口径要先说清（都是刻意的）：

1. **密钥加密存**：`api_key_cipher` = AES-256-GCM（口令取 `AI_MODEL_ENCRYPTION_KEY`，缺省回落 `JWT_SECRET`；
   两者都没配 → 明确报错，**不静默存明文**）。接口**永不回传明文**，只回 `apiKeyHint`（`sk-…abcd`）与 `hasApiKey`；
2. **`raw` 全量留存**：供应商原始 JSON 原样落库（不裁剪）——"模型什么时候消失 / 参数什么时候变了"可复盘；
3. **唯一键 = 同步锚点**：`uk_provider_name (name)`、`uk_model_provider_key (provider_id, model_key)`。
   同步按后者 upsert，所以**重复执行结果一致（幂等）**。

#### 4.8.2 拉模型明细：只收国内厂商，统一走 OpenAI 兼容 adapter

适配范围**限定国内厂商**（OpenAI / Anthropic / Google 三家海外厂商已剔除）。这些厂商对外都提供
OpenAI 形态的"列模型"接口，所以**只有一个通用 adapter**，厂商差别只落在默认 baseURL 上：

| 请求 | 鉴权 | 响应（我们取什么） |
| --- | --- | --- |
| `GET {base}/models` | `Authorization: Bearer <key>` | `data[]`：`id` 是同步锚点；`created` / `owned_by` 等原样进 `raw` |

`kind → 默认 baseURL / 是否支持列模型 / 备注` 登记在 `apps/server/src/modules/ai-model/provider-adapters.ts`
的 `PROVIDER_ENDPOINTS`：DeepSeek、阿里云百炼（`/compatible-mode/v1`）、智谱（`/api/paas/v4`）、
月之暗面、火山方舟（`/api/v3`，列表可能只返回部分）、硅基流动、MiniMax、百度千帆、腾讯混元、阶跃星辰。
讯飞星火官方只提供 chat/completions、没有列模型接口，标 `supportsModelList: false` → 同步直接提示
「请手工新增模型」，**不发必然失败的请求**；`openai-compatible` 保留为**协议形态兜底**
（自建网关 / One-API / vLLM），没有官方默认地址，必须显式配 `baseUrl`。

解析结果统一成：`{ modelKey, displayName?, contextWindow?, maxOutputTokens?, capabilities?, raw }` ——
adapter 是**纯函数 + 一次 fetch**，可以脱离数据库单测（有 mock 服务就够）。
OpenAI 兼容形态通常一页返回全部，翻页只保留"最多 10 页 + `has_more` / `last_id`"的死循环兜底。

#### 4.8.3 同步的语义（哪些会自动改、哪些绝不自动改）

| 情况 | 行为 |
| --- | --- |
| 新模型 | 插入，`source='sync'`，`enabled=true` |
| 已存在的模型 | 更新 `display_name` / 窗口 / `capabilities` / `raw` / `last_seen_at`；**不动 `enabled`**（用户的启停是人的决定，不能被同步覆盖） |
| 这次**没返回**的模型（下线 / 限流 / 权限变化） | **只不更新 `last_seen_at`**，页面显示"本次未返回"，**绝不自动禁用**（限流就会误杀） |
| 同步失败 | 供应商原文写 `last_sync_error` 并抛 3403；成功则清空 |
| 手工添加的模型（`source='manual'`） | 同步不碰（用户自己填的窗口 / 展示名优先） |

#### 4.8.4 接口（`/ai-model/*`，AdminAuthGuard，全部 POST）

`provider/list | create | detail | update | remove | sync | test`、`model/list | update | remove`。
`provider/remove` 与其下模型**软删**（配置类数据保留历史，便于排查"当时用的是哪个模型"）；
`provider/test` 只测连通性不落库（配错了当场知道）。

#### 4.8.5 与 agent 运行时的关系（**本轮不接管**）

本轮 agent 仍按环境变量解析模型（`MASTRA_MODEL` 等），本模块只做"配置与明细的真相源 + 管理页"。
下一步（已设计、未实现）的模型解析顺序：**本轮显式指定的模型 → 库中启用的默认模型 → 环境变量兜底**，
并把 `context_window` 接进 §3.9 的窗口解析（优先库里的实测值，tokenlens 兜底）。
**不一起做的理由**：运行时那套已经端到端验证过，换模型来源属于行为变更，单独一轮做+单独验证更稳。

#### 4.8.6 错误码（34xx 段，**随模块实现时再加**）

`3401` 供应商不存在 / `3402` 模型不存在 / `3403` 拉取模型明细失败 / `3404` 供应商已禁用 /
`3405` 未配置密钥加密口令（`AI_MODEL_ENCRYPTION_KEY` 与 `JWT_SECRET` 都缺）。
（已撤回未使用的错误码 —— 不留死代码；实现模块那一步一起加。）

### 4.9 运行时只用"配过的模型"（选模型怎么落到 agent 上）

**要求**：agent 只能使用后台配好的模型；会话页要能选。

#### 4.9.1 关键机制：Mastra 的模型是 `DynamicArgument`

已核实（`@mastra/core` 1.69.0）：`AgentConfig.model?: DynamicArgument<MastraModelConfig>`，
即**可以传一个 `({ requestContext }) => 模型` 的函数**，每次调用时求值。

这条性质决定了整个设计：**选模型不需要重建 agent，也不需要退回环境变量** ——
模型从我们已有的**运行时信封**（`requestContext`，§3.14.4）里取，子 agent 读同一个信封，天然继承。

```ts
new Agent({
  model: ({ requestContext }) => resolveModel(definition, requestContext),  // 每次调用求值
  ...
})
```

#### 4.9.2 模型解析顺序（**没有环境变量兜底**）

```
本轮显式指定 modelId（会话页选择器）
  → agent 声明里的默认模型
  → 库里第一个"供应商启用 + 模型启用"的模型
  → 一条都没有 → 3406「还没有配置可用的模型，请先在后台模型管理添加」
```

几条硬口径：

1. **解析不出来就不建流、不烧钱**：编排层在组装上下文**之前**就解析模型（失败即抛，run 落 `failed` 留痕）；
2. **不做静默回落**：传了不存在 / 已禁用的 `modelId` 直接 3402 / 3404 —— 用户选了 A 却跑了 B 是最坏的体验；
3. **`MASTRA_MODEL` / `MASTRA_API_KEY` / `MASTRA_BASE_URL` 降级为可选的"种子"**：
   库里一条供应商都没有、而这三个配了时，boot 自动建一条供应商 + 一个模型（`AiModelSeedService`，
   `AGENT_SEED_FROM_ENV=false` 可关）。运行时**永远只从库里解析**；
4. **子 agent 继承父这一轮的模型**（同一个信封），不单独选 —— 避免"父子俩用了两个模型"；
5. **窗口优先用库里配的实测值**（`ai_models.context_window`）：自建网关上的私有模型 tokenlens 根本不认识，
   实测值比公开数据可信；缺失才回落 tokenlens → 兜底值（`ContextWindowResolution.source = 'provider'`）。

#### 4.9.3 前端：模型选择器 + 输出统计（都在输入框底栏）

底栏（ai-elements 的 `PromptInputFooter`）分左右两半：

- **左下角：模型选择器**。ai-elements 的 `ModelSelector`（Dialog + Command 那一套：
  `ModelSelectorContent / Input / List / Group / Item / Name / Logo`），按供应商分组、显示
  `<slug>/<modelKey>` 与窗口、当前项打勾；选中的 `modelId` 随每轮请求发给服务端。
  数据源是 `POST /agent/models`（**只回"供应商启用 + 模型启用"的**）：选择器里能看到的每个模型都是确定能用的；
  **库空时不给可点入口**，直接提示"请到模型管理添加供应商并启用模型" —— 这是"只能使用配的模型"的界面表达。
- **右下角：本轮统计** —— 行内 `N 轮 M 步，输入 X，输出 Y，缓存命中 Z`（`chat/format.ts` 的
  `usageLineText`），悬停给精确值与合计 / 推理 / 耗时（`usageLineTitle`）。数据来自 `data-run-usage`
  （见 §5.4 的 data 块表），历史回看时由 `history.ts` 从 `runs.usage` 重建同一块。
  四条口径：
  1. **数字用 k / m 缩写**（`compactNumber`：`3179` → `3.2k`、`1_250_000` → `1.3m`，一位小数、
     去掉多余的 `.0`、进位后不出现 `1000k`），悬停看精确值（千分位）；
  2. **轮 / 步**：轮 = 该会话第几轮（前端按"已有助手回复数 + 1"算），步 = 这一轮模型被调了几次（`stepCount`）；
  3. **缺失的项整项不显示**（provider 没上报不是 0，编造 0 会让人误判）——
     没有缓存命中时连"缓存命中"四个字都不出现；
  4. 只在这一处显示本轮消耗（见下）。

**消耗只在这一个地方显示本轮值**：侧栏会话列表**不放 token**（只显示"几轮"）。
`conversations.total_tokens` 是**跨轮累计**，和右下角的"本轮消耗"是两个不同的数 ——
同一个词（token）在同一个界面里指两件事，必然让人对不上账。
累计值仍留在库里（§4.7 记的口径），将来要展示就放到会话详情里，不塞列表行。
子助手面板里的那份是**子助手自己的消耗**（已计入父那一轮的合计，`rollUpUsage`），
属于"明细"，与右下角的"合计"并存是刻意的（谁花的钱要查得到）。

**缓存命中（`cacheReadTokens`）的取数口径**（实测确认，踩过）：Mastra 的 `totalUsage` **顶层**就有
`cachedInputTokens`（DeepSeek 同一段提示第二次请求实测 1408），而嵌套的
`inputTokenDetails.cacheReadTokens` 在部分 provider 适配下是空的。`usage.ts` 的 `toUsageRecord`
**顶层优先、嵌套兜底** —— 早先只读嵌套那处，于是"缓存命中"永远是 `null`
（`ai-usage.test.ts` 用实测样本把这条钉住，`ai-stream-e2e.test.ts` 断言 mock 的命中数确实落到库里）。

#### 4.9.4 前端：一个会话一个路由

```
/main/ai/chat                 → 重定向到 /main/ai/chat/new
/main/ai/chat/new             → 「还没建会话」的保留段（首轮发出后服务端回真实 id，页面 replace 成真实地址）
/main/ai/chat/<conversationId> → 某个会话（历史从 timelines + runs 重建）
```

- 侧栏会话列表在 **`chat/layout.tsx`**（路由的 `layout`）：切换会话**不重挂载列表**，
  滚动位置与 query 缓存都保留；列表项是 `<Link href={conversationPath(id)}>`（可新开标签、可前进后退）。
- 对话区在 **`chat/[conversationId]/page.tsx`** → `ChatConversation`，**`key` 用会话 id**：
  切换会话整棵重挂载，`useChat` 内部消息、reasoning 展开态、子助手增量缓存全部隔离（不串会话）。
- **页面铺满内容区、两栏之间可拖动改宽**：页面**不写 `mx-auto max-w-*`**（宽屏下那等于两侧留白，
  内容区有多宽就用多宽）；左右两栏用 `@repo/ui` 的 `resizable`（shadcn 封装的 `react-resizable-panels`）
  分隔，列表栏按**像素**保持宽度（`preserve-pixel-size`，默认 264 / 最小 180 / 最大 420），
  窗口变化时由对话区吸收，分隔条也支持键盘（方向键）。**窄屏（<768px）不渲染列表栏** ——
  用 `@repo/ui` 的 `useIsMobile` 判定（与 Sidebar 同一套口径），条件是"整个 Panel 不渲染"而不是
  给它加 `hidden`（Panel 的尺寸在库的内联样式上，类名盖不住）。
- 消息列表（`Conversation`）与列表行**都不画边框 / 分隔线**：层次靠气泡底色与卡片自己表达，
  两栏的分隔交给那根分隔条。
- 新会话的首轮：流里的 `data-run` 带回真实 `conversationId` → `router.replace` 换地址。
  这也是不把首轮拆成"先建会话再跳"的原因：那样会多一次往返、还要处理"建了会话却发失败"的空会话。
  **⚠️ 修正（2026-10-27，Next 16.3.5 实测）**：早先这里写的是"同一动态路由换参数不会重挂载"，
  这是**错的** —— 换参数时 Next 要重新取这一段 RSC，页面子树会被卸载再挂回来（CDP 实测：`textarea`
  元素被换掉、`loading` 又变回 true）。`useChat` 的消息不丢，是因为 Chat 实例按 `id` 存在组件外；
  **组件里的 `useState` 会全部归零**。所以会话页凡是要跨"首轮建会话"活下来的选择，都必须存在
  React 之外，别再假设"挂载一次、状态只有一份"。
- **模型选择按会话存在浏览器里**（`ai-chat-model:<会话 id>`，见 `chat-conversation.tsx` 的
  `MODEL_STORAGE_PREFIX`）：正因为上面那次重挂载，只放组件 state 的选择会被清掉，表现成"选了非默认模型，
  一发消息就回到默认"（那一轮实际用的仍是选中的模型，`runs.request_snapshot.model` 可查）。`new` 那一段
  是"下一个新会话的待用选择"，首轮拿到真实 id 时搬到真实 id 上；存的选择若已不在可选清单（模型被删 /
  停用）由 effect 归零，交回服务端默认 —— 否则每轮都会拿一个不存在的 id 去换 3402。

#### 4.9.5 跑对话用哪个 SDK：**由供应商 `kind` 决定，不由 slug 决定**

`kind` 同时驱动两件事，两者刻意分开（`modules/ai-model/provider-adapters.ts`）：

| 表 | 管什么 |
| --- | --- |
| `PROVIDER_ENDPOINTS` | **列模型**怎么拉（`GET {base}/models` 的形态与默认地址） |
| `OFFICIAL_ADAPTER_KINDS` | **跑对话**用哪个 SDK（`usesOfficialAdapter(kind)`） |

两条硬约束（都踩过，直接表现为"前端看不到思考"与"运行判成失败"）：

1. **官方适配不能传 `url`**：`{ id, url, apiKey }` 里的 `url` 会把请求降级到通用 OpenAI 兼容层 ——
   DeepSeek 的思考字段叫 `reasoning_content`，通用层不认它，**整段思考被丢掉**；同时
   `agent.stream()` 的返回形态也从 `MastraModelOutput` 变成可恢复执行的工作流包装对象
   （`{ output, fullStream, runId, … }`，真正的输出在 `output` 字段里）。
   → 官方适配只传 `{ id, apiKey }`；用户若配了 `baseURL` 会被忽略，但**必须记一条 warn**（不静默）。
2. **判据是 `ai_providers.kind`，不是 `modelRef` 的 slug 前缀**：slug 是展示字段，人能改、还能撞名
   （种子供应商的 slug 就是 `env-default`）—— 用 slug 判断会让官方适配在改个 slug 之后静默失效。

决策收敛成一个纯函数 `decideModelForMastra(model)`（`modules/ai/core/model-decision.ts`），
由单测直接锁住上面两条（`test/ai-model-decision.test.ts` + 端到端 `test/ai-model-selection-e2e.test.ts`）。

**流结果的读取口径**（`modules/ai/runtime/stream-result.ts`）：`agent.stream()` 有**两种返回形态**
（普通 / durable 包装），`steps` 与 `totalUsage` 一律经 `readStreamSteps` / `readStreamUsage` 读，
**绝不直接写 `output.steps`** —— durable 下那是 `undefined`，`steps.entries()` 会把**已经跑完并展示给用户的
一轮**判成 failed（现象：回答流出来了，但运行是失败的、会话没有轮次与标题）。

#### 4.9.6 与 §4.8 的关系

§4.8 是"配置的真相源"（供应商 / 模型的表与同步），§4.9 是"配置怎么被消费"。
一句话：**后台配什么，agent 就能用什么；没配的一律用不了**（这不是约定，是解析路径上只有一条）。

### 4.10 会话命名、会话改名与「查看系统指令」（**本轮新增，以此为准**）

#### 4.10.1 首轮自动命名：**让模型起名，且与 agent 上下文完全隔离**

要求（用户口径）：第一轮对话结束后，把对话记录交给模型起一个**≤10 字**的名字，
**与当前 agent 上下文完全隔离**。

| 决策 | 落法 | 为什么 |
| --- | --- | --- |
| 时机 | 收尾阶段（`recorder.finish` 之后、`runs.finish` 之前），**只在首轮**（开局 `turnCount === 0`） | "这一轮完了"才拿得到完整记录；首轮之后名字已定，不必再花一次钱 |
| 隔离 | 现场造一个临时 agent：**只有命名指令、没有工具 / 技能 / 记忆 / 运行时信封**，模型用这一轮实际用的那个 | 直接复用 `mastra.getAgent()` 会把整套 agent 系统提示词与工具定义带进去 —— 那不是"隔离" |
| 输入 | 只取该 run 的**用户 / 助手文本**（按 seq），封顶 2000 字符 | 工具入参出参与推理过程对命名是噪声 |
| 长度 | 提示词写死 `≤10 字` + 输出 `maxOutputTokens: 32` + **按码点硬截断**（`Array.from`，emoji / 生僻字不会被切成半个） | "只输出名字"这条要求模型经常做不到，得收拾：只取首行、剥 Markdown / 引号 / 书名号 / 序号 / 结尾标点（`sanitizeTitle`，有单测） |
| 花费 | 这次调用的 usage **并进该轮 run**（`mergeUsage`） | `runs.usage` 的语义是"这一轮花掉的钱"；分开记会让账目凭空少一块。它**不占 `step` 行**（不是回答的一步） |
| 兜底 | 超时（10s `AbortSignal.timeout`）/ 报错 / 收拾不出名字 → **保留"首条消息"那版** | 起名是锦上添花，不能影响一轮问答 |
| 不覆盖人工名 | 只在标题**还是兜底那版**时才改名 | 用户改过的名字永远不被后台悄悄冲掉 |
| 模板 | 命名指令走 `prompts/templates/title.eta`（提示词文本只走引擎的硬约定不破） | 与其它提示词同一处可评审 |

> 注：这一条**推翻了早先"标题不额外调模型（省钱）"的取舍** ——
> 首条消息截断出来的名字（"帮我看看最近有哪些待办"）在侧栏又长又难认，用户明确要求改为模型起名。

**改名怎么让前端"当场"知道**（用户反馈过"重命名没有前端实时响应"）：两条一起做，各管一段 ——

| 手段 | 管什么 | 为什么 |
| --- | --- | --- |
| 流里推 `data-conversation-title`（带 `runId` / `conversationId` / `title`，收尾时下发，与 `data-run-usage` 同一手法进 Redis） | **标题**：前端就地 `setQueryData` 改列表项与会话详情 | 标题在服务端收尾时才定，前端那份缓存不会自己知道；就地改不用整份重拉，也覆盖断线补发 |
| 一轮结束（流关闭）后失效 `['ai','conversations']` 与 `['ai','conversation',id]` | **轮数 / token 累计 / 列表排序** | 这些只在库里变；不重取就一直显示旧值（"跑完还是 0 轮"、第一轮答完显示"2 轮"都是这类） |

> 前端还有两处配套：`message-row` 显式吃掉 `data-conversation-title`（否则掉进"未知 part"分支渲染成徽标）；
> 用量行的"第几轮"改成"助手消息条数（至少 1）"—— `useChat` 的 `messages` 里已经含正在流的那一条，
> 原来的 `+1` 会多算一轮。

#### 4.10.2 会话改名（手动）与会话删除（前端接上）

- `POST /agent/conversation/rename`（`{ conversationId, title(1..30) }`）：归属校验（3304）→
  `setTitle` → **记一条 `status` 时间线事件**（`reason='conversation_renamed'`，带 `from` / `to` / `operator`）。
  名字没变则不写库也不记事件（避免"点开又确认"刷出无意义审计）。
- `POST /agent/conversation/remove`（已有）：软删会话（**唯一删除入口**），删前先结束在跑的运行并记事件。
- 前端（admin `main/ai/chat`）：侧栏每行悬停出现 `重命名` / `删除`；
  **行操作是 `<Link>` 的兄弟节点**（`ConfirmAction` 的触发自带 onClick，嵌在 Link 里点一下会连带跳转）。
  删除的正好是当前会话时跳回 `/main/ai/chat/new`。

#### 4.10.3 查看系统指令：**看这个会话真正用过的**（渲染后落库）

要求（用户口径）：要看的不是"模板现在长什么样"，而是**当前会话渲染后的系统指令**，而且**要存到库里**。

**落库**（编排层，每个 root run 一次）：

- 这一轮送进模型的系统指令全文 = `definition.instructions`（装配期渲染）+（仅首轮的）运行环境片段，
  由 `AgentChatService.resolveSystemPrompt()` 组装成**一个字符串**：
  - 同一个字符串既放进运行时信封的 `systemPrompt`（`ai.mastra.ts` 直接拿它当 instructions，
    不再自己拼），也**落一条 `kind='system'` 时间线事件** —— "模型看到的"与"库里存的"永远是同一份；
  - 落库规则与字典里那句"同一会话提示词没变时只写一次"一致：**逐字相同就不写**，
    于是每个会话只在提示词真变的拐点留点（首轮一条带环境的、之后一条不带的），不会每轮灌重复行。
- 事件 payload：`{ text, agentKey, environmentInjected }`（一眼看出这条是哪种形态）。

**读接口**：`POST /agent/instructions`

| 入参 | 回什么 | `source` |
| --- | --- | --- |
| 带 `conversationId` | 该会话**最近一条系统指令快照**（归属校验 3304；`agentKey` / 展示名按快照里那个 agent 解析） | `conversation` |
| 会话还没有快照（刚建 / 历史会话早于这一步） | 退回装配期的**静态定义**（不编造一份"看起来像快照"的东西） | `definition` |
| 不带 `conversationId`（或只给 `agentKey`） | 静态定义；未注册的 agentKey 抛 3303，**不静默回落成默认 agent** | `definition` |

**前端**：会话页页头「系统指令」按钮 → 弹窗（等宽、可滚动）显示原文，并按 `source` 如实标注
"本会话实际使用的（渲染后快照）"还是"当前 agent 的静态指令（本会话还没有运行记录）"；
每次打开都重取（`staleTime: 0`），所以"这一轮刚改了提示词"也能立刻看到。

## 5. 前端全细节流式（调研已回，本节定稿）

### 5.1 传输与协议（已核实）

- 服务端：`toAISdkStream(result, { from: 'agent', version: 'v6' })` → `pipeUIMessageStreamToResponse({ response, stream })`；
  写出的头是 `content-type: text/event-stream`、`cache-control: no-cache`、`connection: keep-alive`、
  `x-vercel-ai-ui-message-stream: v1`、`x-accel-buffering: no`（最后这个关掉 nginx 缓冲，否则我们前面的
  网关会攒着不发、表现为"没有流式"）；
- 线格式 `data: {json}\n\n`，以 `data: [DONE]\n\n` 结束；
- ⚠️ `x-vercel-ai-ui-message-stream: v1` 官方客户端**不读也不校验**，它只是给自建后端的协议自描述 ——
  所以**跨版本兼容不能指望它**，要靠我们锁死 `version: 'v6'`。

### 5.2 要渲染的 part 清单（需求 E 的"每个细节"）

`UIMessage.parts` 是 **9 类联合**：`text`（state: streaming/done）、`reasoning`、`tool-<名字>`、
`dynamic-tool`、`source-url`、`source-document`、`file`、`data-<名字>`、`step-start`。
工具 `state` 共 **7 态**：`input-streaming` / `input-available` / `approval-requested` /
`approval-responded` / `output-available` / `output-error` / `output-denied`（后三个是 v6 新增）。

**chunk 与 part 不是一回事**（24 种 chunk + `data-*` 通配）：
`text-*` 三个 chunk 合成一个 `text` part；`start` / `finish` **不产生任何 part**
（`start` 只注入 `messageId` 与 metadata —— 这正是"续传接回同一条消息"的基础）；
`start-step` → `step-start` part；`transient: true` 的 `data-*` chunk **不产生 part**。

### 5.3 续传与停止：官方只给原语，**两端点都得我们建**

AI SDK v6 的续传是**两层 API**（不是同一方法的两个名字）：
`useChat().resumeStream()`（Hook 层）→ `transport.reconnectToStream()`（传输层）；
默认续传端点是 **`GET {api}/{chatId}/stream`**，服务端**必须以 `204 No Content`** 表示"没有进行中的流"。

官方示例里 **Redis、activeStreamId 记录、POST 建流 / GET 续流两个端点、`resumable-stream` 集成，
全部要自建**（SDK 只提供 `resume` 选项与 `consumeSseStream` 钩子）。更麻烦的是：
官方示例依赖 Next.js 专有的 `after()` / `waitUntil`，**我们不是 Next.js，官方没有等价替代示例** →
需要我们自己实现"响应结束后继续收尾"的机制（见 §7 待拍板项）。

⚠️ **最容易踩的语义坑**：在 `resume: true` 下，`chat.stop()` **只是断开连接，并不取消生成**
（官方原文 + 专门的 troubleshooting 页）。要真正停止必须自建 stop 端点：
读 activeStreamId → 落库 partial 的 assistant 消息 → 取消 producer → **仅当 activeStreamId 仍相同才清空**；
并且**禁止在组件 unmount / 路由 cleanup 里调 stop**（那会把正在跑的生成掐掉）。

**续流为什么必须暴露成 GET（两处 GET 例外）**：AI SDK 的 `reconnectToStream` **固定发 GET**，
所以"按 run 续流"（`GET /agent/run/:runId/stream?offset=N`）与"不知道 runId 时按登录用户续流"
（`GET /agent/run/stream?offset=N`，服务端在库里找当前进行中的那一轮，没有就 204）都只能是 GET。

⚠️ **踩过的坑**：`useChat({ resume: true })` 挂载时**一定会**发一次续流 GET。若 `prepareReconnectToStreamRequest`
在拿不到 runId 时退回建流地址（`/agent/chat/stream`，POST-only），浏览器就会对建流路由发 GET → **404**。
前端侧的正确做法是用"按用户续流"那个端点（没有进行中的流 → 204 → SDK 静默收尾）。

### 5.4 业务状态机怎么进前端（同一条流、两种通道）

- **持久 `data-*` part（固定 id）**：同 id 重写即**就地 reconcile**，且**刷新后随历史 `messages` 自动还原**
  → 正是"排队 / 运行中 / 已在恢复 / 已中断 / 失败 / 完成"这类**状态**该走的通道；
- **`transient: true` 的 data chunk**：只触发 `onData`、**绝不进 parts** → 进度百分比、心跳、toast 用它；
- `messageMetadata`：消息级信息（时间戳 / 模型 / token），在 `start` / `finish` 下发，
  要类型安全需传 `originalMessages`。

两者都走同一条流 → **状态与内容天然同源，不会出现"消息到了状态没到"的错位**。

**本工程实际使用的 data 块（已在流式 e2e 里断言）**：

| 块 | id | 谁写 | 用途 |
| --- | --- | --- | --- |
| `data-run` | 不带 | 编排层（`chatStream` 开头第一个片段） | **本轮身份**：`runId` / `conversationId` / `agentKey` —— 前端据此记住 runId（停止与重连只认它），新建会话时也靠它拿到 conversationId |
| `data-run-usage` | 不带 | 编排层（**收尾落库之后、`[DONE]` 之前**） | **本轮用量**：`usage`（输入 / 输出 / 缓存读 / 推理 token，缺失一律 `null`）+ `stepCount` / `toolCallCount` / `durationMs`。为什么走流而不是让前端再查一次：用量只有收尾时才知道，而这个位置是唯一能保证"客户端看到用量时库里也一定有了"的地方；同时进 Redis 输出记录与广播，所以断线补发也拿得到。前端渲染在**输入框右下角**（k / m 缩写 + 悬停精确值，见 §4.9.3）；历史回看时 `history.ts` 从 `runs.usage` 重建同一块 |
| `data-sub-agent` | **带**（= 子 run id） | `run-sub-agent` 工具（经工具上下文的 `writer`） | 子助手状态快照：status / 结论 / 步数与工具次数 / usage（§3.14.5） |
| `data-sub-agent-delta` | 不带 | 同上 | 子助手的流式增量（text / reasoning），一块一个。**前端在传输层把它标成 `transient`**（`chat-transport.ts`），只走 `onData`、不落 part —— 否则一块一个 part 会把页面拖死，见 `ai-chat-state.md` |

⚠️ `data-run` 与业务片段走**同一条记录 + 广播通道**（进 Redis 输出记录），所以断线补发时也一定先拿到它
—— 前端不需要额外接口去问"我刚才那一轮的 runId 是多少"。

### 5.5 AI Elements 的映射要靠我们写（组件不读 parts）

调研的硬结论：**8 个核心组件没有一个 import `useChat`、没有一个读 `message.parts`**，
全部只收 props；源码里没有 `source-url` / `data-*` / `file` / `step-start` 字面量。
→ **part → 组件 props 的映射表由我们在页面层实现**（这也意味着映射规则完全可控）。

| 类别 | 组件 | 注意 |
| --- | --- | --- |
| **运行态** | `reasoning`（`isStreaming`：自动展开 / 计时 / 结束后 1000ms 收起）、`tool`（七态查表；**`input-available` 才是 "Running"**，`input-streaming` 是参数还在流）、`confirmation`（`approval-requested` 才显示请求与动作）、`plan`、`terminal`、`conversation`（`use-stick-to-bottom` 自动吸底） | 这些是"跑起来看得见"的关键 |
| **结果展示** | `task` / `sources` / `context`（token 用量）/ `checkpoint` / `queue` / `artifact` / `code-block` / `stack-trace` / `test-results` | 无状态判断，纯展示 |
| **消息级** | `message`（`from: 'system'\|'user'\|'assistant'`，源码只区分 user）、`MessageResponse`（流式 Markdown）、`MessageBranch*`（配 `regenerate()` 多版本） | — |

⚠️ **工具审批闭环要自己接线**：`confirmation` 的 `ConfirmationAction` 只是个 Button，
源码里没有 `addToolApprovalResponse` 调用 —— 需要我们自己调
`addToolApprovalResponse({ id, approved, reason })` 并用
`sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses` 才能闭环。

### 5.6 必须记住的坑（按危险度）

1. **`isToolUIPart` 语义在 v6 被反转**：v5 的 `isToolUIPart` → v6 叫 `isStaticToolUIPart`；
   v5 的 `isToolOrDynamicToolUIPart` → v6 才叫 `isToolUIPart`。**v5 代码在 v6 能编译通过但语义已变**，最危险；
2. **服务端错误细节默认不下发**（`onError` 默认 `() => 'An error occurred.'`）→ 要让用户看到真实失败原因，
   必须显式传 `onError`；
3. `uiMessageChunkSchema()` **不能当服务端校验器**（实测非法 `type` 也能通过）；
4. `convertToModelMessages` 在 v6 变 **async**（必须 `await`）；
5. React 19 StrictMode 下**没有官方指南**（调研确认 grep 无命中）→ 别自己在 `useEffect` 里调
   `resumeStream()`，用 `resume: true`（源码内部已有并发去重）；
6. 官方文档里 `writer.write({ type: 'source' })` 与按 `part.type === 'source'` 渲染**都是错的** ——
   v6 只有 `source-url` / `source-document`。

### 5.7 会话页的"旁证"：运行态、复制与右栏（**本轮新增，以此为准**）

**① 会话列表的运行态（呼吸灯）**：`AgentConversationModel.running` 是**查询时算出来的**，
不是会话表上的字段 —— 真相在 `runs`：根 run（`parent_run_id IS NULL`）状态为 `pending` / `running`
即为"这一轮还在跑"（与部分唯一索引 `uk_run_active_conversation` 同一口径）。
`conversation/list` 对本页会话**批量查一次**，`conversation/detail` 单查；
`create` / `rename` 这类写操作一律回 `false`（前端以列表 / 详情为准，不靠写操作的返回值判断运行态）。
前端：行内呼吸灯 + **只要还有在跑的会话就 5s 轮询列表**，全跑完立刻停（不留一个常转的定时器）。
⚠️ 服务端看门狗把超时的一轮判成 `failed` 之后，`running` 自然回落 —— **呼吸灯消失不等于"跑过"**，
排障要回 `runs` 看真实状态与 `error_code`。

**② 复制**：页头可复制**会话 id**（排障时一次贴清楚，比截图靠谱）；
每条消息可复制为 **Markdown**（保留结构：思考用引用块、工具与代码用围栏）或 **纯文本**
（剥掉 Markdown 标记）。两条硬口径：
- **顺序即所见**：按 `message.parts` 原始顺序导出，工具卡就地铺开（不是攒到结尾）；
- **协议管道不进导出**：`step-start` / `data-run` / `data-run-usage` / `data-conversation-title` /
  子助手增量块都不导；被计划卡片吸收的计划类工具调用也不重复导（与 `MessageRow` 渲染口径一致）。

`markdownToPlainText` 是**够用就好的剥离器**（先把围栏代码块整体摘出，再处理行内与块级标记），
不是完整 Markdown 解析器 —— 目标是"粘进记事本不带符号"，不是无损反解析。

**③ 右栏**（页头图标开关；宽度可拖、开关状态存在浏览器里）：

| tab | 内容 | 数据源 |
| --- | --- | --- |
| 系统指令 | 本会话**渲染后的快照**（没有快照时回静态定义并标注来源），`Markdown` 组件渲染 + 一键复制 | `POST /agent/instructions` |
| 子 agent 运行 | 内层再分 tab：**一个子 run 一个 tab**（同名跑多次补 `#序号`） | `run/list` + `timeline/list?runId=` |

- 系统指令原来挤在页头弹窗里（§4.10）——本轮搬进右栏，**弹窗撤掉**（同一件事不留两个入口）；
- 子助手的过程用**主对话同一个** `MessageRow`，消息用 `toUIMessages(items, runs, { onlyRunIds })` 重建：
  "渲染和主 agent 一样"是**结构上的事实**（同一套映射 + 同一套组件），不是照抄样式；
- 只挂**当前那个 tab** 的时间线查询：多个子 run 一起拉是白花的请求；
- 右栏默认 340px、最小 260px，`preserve-pixel-size`（窗口变宽由对话区吸收，与左侧列表栏同一套口径）。

### 5.8 富内容围栏：模型直接画图、写页面、做动画

正文里的围栏按语言标识分流渲染，扩展点是 Streamdown 的 `plugins.renderers`（`language → 组件`），
**不需要 fork 解析层**。完整设计（含安全模型与测试点）见
[ai-markdown-fences.md](./ai-markdown-fences.md)，这里只留结论：

| 围栏 | 渲染 | 说明 |
| --- | --- | --- |
| ```` ```mermaid ```` | mermaid 11 → SVG | 已有（`@streamdown/mermaid`） |
| `$$ … $$` | KaTeX 块级公式 | 已有；本轮补上 `katex.min.css`（没样式时公式是错位的）；`$…$` 行内**保持关闭**（会和金额撞） |
| ```` ```xflow ```` | JSON → React Flow | 模型只给"谁连谁"，排版由前端用 **dagre**（官方布局示例同款）算，画布与 dagre 一起按需加载 |
| ```` ```html ```` | 沙箱 iframe 直出页面 | 能跑 `<script>`，但拿不到后台权限；可全屏 |
| ```` ```gsap ```` | 沙箱 iframe + 内置 gsap | gsap 由父页面同源取回（`public/vendor/gsap.min.js`），版本走 `pnpm -F @app/admin sync:vendor` 同步；可全屏 |
| ```` ```json ```` | 可折叠 JSON 树 | 组件是 `@repo/ui` 的 `JsonView`（有 200KB / 2000 条上限，超了退回原文） |

三条必须守住的边界：

1. **沙箱不是可选项**：`sandbox="allow-scripts"`（不带 `allow-same-origin`）+ 文档内 CSP `default-src 'none'`，
   模型写的代码连不出去，也读不到父页面；
2. **围栏没闭合不渲染**：`html` / `gsap` 每来一个 token 重建 iframe 等于把脚本反复重跑，`xflow` 会来回跳；
   判定靠 `isAnimating`（`message-row` 传 `streaming && part.state === 'streaming'`）；
3. **提示词要说清能写什么**：围栏存在 ≠ 模型会用，写法与"不要引用外部资源"写在
   `core/prompts/templates/partials/requirements.eta` 的「富内容围栏」一节；同一节还**禁止字符画拼图**
   （中文等宽两格，框线必然错位），结构图一律走 `xflow` / `mermaid`；
4. **正文代码块不带行号**：`MessageResponse` 显式传 `lineNumbers={false}`（上游默认 `true`），
   否则字符画 / 长行文本会被行号栏挤窄。

## 6. 依赖、代价与风险（先说清代价，再谈做不做）

### 6.1 新增依赖（版本已核实）

| 包 | 版本 | 用途 | 许可 |
| --- | --- | --- | --- |
| ~~`@mastra/memory`~~ | — | **本轮不需要**（记忆先不做，见 §4.3/§4.4） | — |
| `tokenlens` | 1.3.1 | **模型上下文窗口**（解析 §3.9 的 W）+ 价目；前端 ai-elements 的 `context` 组件同款，前后端共用一套模型元数据 | MIT |
| `@mastra/redis` | 1.4.6 | `RedisServerCache`（事件重放跨实例） | 多实例才需要 |
| `@mastra/redis-streams` | 0.5.0 | `RedisStreamsPubSub`（跨实例事件 + abort + 恢复租约） | 多实例才需要 |

> `@mastra/pg` **本轮不需要**：存储适配器由我们自己实现（§4.4），表走 TypeORM 迁移；
> 连带省掉了自动建表、`exportSchemas`、运行时 DDL 权限这一串问题。
> 将来若开向量检索，才需要重新评估它（或自建 vector adapter）。

### 6.2 代价（不是"顺手就有"的部分）

1. **崩溃恢复要真花钱**：`recover()` 重发 LLM 调用并重跑工具（官方明文）—— 恢复一条长会话
   可能等于再付一次模型费用；
2. **工具必须幂等**：否则恢复一次就多一条脏数据（业务写工具现在就会）；
3. **自建 storage adapter 有维护成本**：要跟着 Mastra 的 storage 接口演进（目前 memory 10 + workflows 9 个方法），
   Mastra 升级时要回归一次。换来的是表结构完全自主、无运行时 DDL 权限需求、也没有双写不一致问题；
4. **向量检索还有额外成本**：embedder 按 token 计费 + 向量存储与索引维护。

### 6.3 风险

| 风险 | 具体 | 处置 |
| --- | --- | --- |
| **zod 双份** | `@mastra/memory@1.31.0` 依赖 `zod ^4.6.4`，本仓锁 `^4.4.3`（lock 里实际 4.4.3）→ pnpm 会为它单独装一份 zod 4.6.x | 倾向**把全仓 zod 升到 `^4.6.5`**（同大版本，改动面是 4 个 package.json + lock + 跑测试）；不升则要实测 Schema 互操作（`createTool` 走 Standard Schema，理论上互通，但没验证过） |
| 自建 adapter 与版本耦合 | Mastra 升级若调整 storage 接口（增删方法），我们的 adapter 可能编译不过或行为漂移 | 适配层集中在一个目录、注释标注"对齐哪个版本"；升级清单里把"跑 adapter 回归"列为必做 |
| ~~Mastra 表与业务表同库~~ | 已由"自建 adapter"决策消除 —— 不存在官方表 | — |
| 多副本恢复租约 | 官方文档说"无分布式锁"，1.69.0 代码里却有 `#acquireRecoveryLease` + `RedisStreamsPubSub implements LeaseProvider` | 上线前**实测**：两个副本同时 boot，看是否只有一个执行恢复 |
| 恢复语义与用户预期 | "重启后接着跑"在崩溃场景会**重放已完成的部分**（重复文本/重复工具调用） | 业务状态机里显式区分 `running` / `recovered` / `interrupted`，前端如实标注"本轮已恢复重跑" |
| **`stop()` 语义陷阱** | `resume: true` 下 `chat.stop()` 只断线、**不取消生成**（官方原文） | 必须自建 stop 端点（落 partial → 取消 producer → 条件清空 activeStreamId）；禁止在 unmount 里 stop |
| **`after`/`waitUntil` 无等价物** | 官方续传示例依赖 Next.js 专有钩子，非 Next 环境**官方没有替代示例** | 自己实现"响应结束后继续收尾"（见 §7 第 6 项），并为此写验收用例 |
| 前端两条信息来源 | AI 内容流（parts）与业务状态（data part）若各自实现，容易出现状态与内容错位 | 状态**走同一条流的持久 `data-*` part**（§5.4），不另开第二条通道 |

## 7. 决策记录

**本轮已拍板**：

| 决策 | 结论 |
| --- | --- |
| 崩溃恢复 | **必须做**（默认开启，带配置开关 + "恢复失败→标记中断"兜底） |
| zod | **全仓升 `^4.6.5`**（已执行并验证：typecheck 4 包 + test 7 包全绿） |
| 数据表 | **不用官方表，自己设计** → 自己实现 storage adapter（§4.4） |
| 记忆 | **先不做**：不引入 `@mastra/memory`、不建记忆表；上下文自己从 `timelines` 取最近 N 条（§4.3） |
| 消耗统计 | 口径与位置见 §4.7：**轮** = `runs` 行、**步** = `steps.length`、token = `totalUsage`；**金额不落库** |
| 删除口径 | **只能删会话、只能软删**；`runs` / `timelines` 无删除入口（审计证据）；软删前先结束在跑的运行（§4.5） |
| 防篡改 | **先不做 hash 链**，改为：应用层只追加 + 部署只授 INSERT/SELECT + 删除只做软删标记（§3.8 A） |
| **子 agent 的创建方式** | **运行期由工具动态创建**（`SubAgentCore.asTools()` 的 `run-sub-agent`），**删除**装配期静态 `subAgents` 声明与 Mastra 的 `agents:{}` 委派（§3.14） |
| **子 agent 的提示词** | **由主 agent 现场撰写**（工具的 `system_prompt` 入参，必填）；不再有 `analyst.eta` 这类静态子 agent 提示词 |
| **子 agent 的工具面** | **全部工具 − 委派类工具**（`delegation` 标记）→ 天然深度 1，不会无限递归 |
| **子 agent 的落库** | 独立 `runs` 行（`parent_run_id` / `depth` / `tool_call_id`）+ 自己完整的 `timelines`；动态 prompt 全量落 `request_snapshot`；消耗汇总进父 run，**轮数只数根 run** |
| **对话附件** | **只传存储 key、不传文件内容**（请求体与文件大小无关）；图片走 `image` part 的 data URL、文本类内联、**PDF 本地抽文字内联**；时间线只落元数据（§3.16） |
| **多模态能力的建模** | **模型实体的独立字段**（`mode` + `input_modalities` + `output_modalities`），不塞进 `capabilities` jsonb。模态数组对齐 **OpenRouter** 的 `architecture.input_modalities`，类型字段对齐 **LiteLLM** 的 `mode`（§3.16.5） |
| **未声明的语义** | `null` = 未声明（**不拦**附件，只提醒）与 `[]` = 明确什么都不支持（拦）**是两件事**；供应商给了就落库、没给不编造；同步不覆盖人工填的值 |

**仍待你定**（给了推荐，你可以直接说"按推荐"）：

1. **长期记忆形态** → 推荐**本轮不开 `semanticRecall`**，用工作记忆（resource 级）+ 观察式记忆承载；
   理由：① 向量会在这条"自建表"路线上留一张**官方表**（`PgVector` 自建 `memory_messages`），
   ② 还要 embedder 成本与运行时 DDL 权限，③ 配不全时 Memory **构造直接失败**（不是降级）；
2. **续传 / 停止怎么落地**（§5.3）→ 推荐**用既有 `RedisStore` 自建**
   （流缓存 + activeStreamId + POST 建流 / GET 续流 + 204 语义 + 独立 stop 端点），
   不引 `resumable-stream`；`after`/`waitUntil` 的等价物挂在既有 **scheduler** 上做收尾；
3. **ai-elements 全量 48 文件** → 推荐**照原计划**进 `@repo/ui` 子路径、不进 barrel（§1 已按此落地）。

## 8. 落地顺序（方案定稿后）

1. **数据模型与表**：设计并迁移三张表 —— `conversations`（会话）/ `runs`（运行 + 消耗）/ `timelines`（消息与推理事件）；
2. **storage adapter**：`MastraCompositeStore` 子类 + **只剩 `workflows` domain（9 个方法）**，跑通「durable agent 快照落我们的表」；
3. **运行时会话服务**：thread / run 业务状态机 + 归属校验（Mastra 不做 ACL）+ **幂等工具**（恢复重跑的硬前提）+ **上下文组装**（最近 N 条 timeline）；
4. **消耗、轮数与步数统计**（§4.7）：流结束后读 `totalUsage` / `steps` / `toolCalls` → 写 `runs`，并累加 `conversations` 的冗余列；
5. **durable agent 接入**：`recoverAllDurableAgents()` boot 恢复 + **多副本租约实测**；
6. **流式端点**：POST 建流 / GET 续流（含 204 语义）+ 独立 stop 端点 + 业务状态的持久 `data-*` part；
7. **core bean 与动态子 agent**（§3.14）：`AgentCore.asTools()` + `PlannerCore` / `SubAgentCore` +
   `AgentRunner`（子 run 执行器）+ 运行时信封 + 迁移（父子列与索引换条件）+ 子 agent 明细入库 + 配额守卫；
8. **数据结构 + SDK + 前端会话页 / 后台审计页**（AI SDK v6 + ai-elements 全量组件，含用量与统计、嵌套子 agent 面板）；
9. 守卫与验收（含离线 mock 端到端）+ 文档 / skill 同步 + 提交。

## 附：本轮已推翻的错误假设（记录以防重犯）

| 曾经的想当然 | 事实 |
| --- | --- |
| 「run 状态应该有自己的表，查 `mastra_agent_runs`」 | 没有该表；run 快照在 `mastra_workflow_snapshot` |
| 「重启恢复就是重新 attach 一下」 | 进程死后只能 `recover()`，**会重跑**（重发 LLM 调用 + 重跑工具） |
| 「Mastra 有 HTTP 续传端点」 | 没有；`resume-stream` 是恢复 suspended run，不是续传断线流 |
| 「`agent-controller` 是 run 状态机」 | 它是给 TUI 用的多 mode 编排统一入口，`runId` 在其中 0 命中 |
| 「app 层要用 `chatRoute()`」 | 它依赖 Mastra server；我们只能用 `handleChatStream` / `toAISdkStream` |
| 「子 agent 该在装配期用 `subAgents` 静态声明」（旧设计） | 与"提示词由主 agent 现写、通过工具创建"冲突；`context.writer` + `data-*` 透传已核实，**运行期动态创建才是正解**（§3.14） |
| 「工具拿不到运行时上下文」 | `ToolExecutionContext` 里有 `requestContext` / `agent.toolCallId` / `writer` / `abortSignal` 四样，编排层注入信封即可（§3.14.4） |
| 「子 run 会和父 run 撞 `uk_run_active_conversation`」 | 会；该部分唯一索引必须加 `parent_run_id IS NULL`（§3.14.3） |

### 3.17 联网（搜索 / 抓取 / 请求）（**以此为准**）

#### 3.17.1 三个工具，各管一段

| 工具 | 给谁用 | 行为 | 返回 |
| --- | --- | --- | --- |
| `web-search` | 模型**找** | 调 DeepSeek 搜索接口（`/v1/tools/search`） | 排序后的来源清单：标题 / 链接 / 摘要 / 时间 / 相关度 / 权威度 |
| `web-fetch` | 模型**读** | 一次 GET，HTML → Markdown（Turndown），脚本 / 样式 / `nav` / `aside` 丢掉 | 正文按页 + 标题 + 状态 |
| `web-request` | 模型**调** | 任意方法 / 头 / body，不洗正文（HTML 才转 md，JSON 展开成多行） | 状态码 + 响应头子集 + 正文按页 |

为什么不合成一个：三件事的"下一步"不同。搜索只回答"**去哪找**"（给摘要与 URL，不搬正文）；
抓取回答"**这页写了什么**"；请求回答"**这个接口返回了什么**（含 401 / 500）"。
合起来会让"一次搜索"顺带把多页正文塞进上下文，也会让 `web-request` 的非 2xx 语义
被搜索的错误口径污染（搜索的非 200 全是接口错误，抓取的非 2xx 却是要原样给模型看的结论）。

**选择顺序（2026-10-19 定）**：`web-fetch` / `web-request` **优先** —— 有 URL 就直取、
有接口就直调；`web-search` 是**兜底**（确实不知道去哪找），搜到 URL 后仍用 `web-fetch`
读正文。这条口径写在两处：工具说明约束"单次选择"，`assistant.eta` 的边界段约束"这一轮的路线"。

#### 3.17.2 分页：按行，不按字节

引擎那套 `paginate` 是按**字节**切的，给任意 JSON 出参兜底没问题，但网页正文按字节切会切在
句子中间，而且取下一页要走 `read-tool-result`（模型得先知道有这个工具）。所以抓取与请求
这两个工具**不声明 `paginate`**，自己按行分页（搜索不分页）：

| 口径 | 值 |
| --- | --- |
| 每页行数 | 1000（工具配置 `pageLines`，可调；页数按它算，改配置等于另一份缓存） |
| 出参元信息 | `document.chars` / `document.lines` / `document.pages` / `document.pageLines` / `document.bytes` |
| 本页位置 | `page.current` / `page.total` / `page.remaining` / `page.isLast` |
| 页脚 | 每页**正文末尾**追加一行：`共 N 页，当前第 X 页，还剩 Y 页（1 页 = 1000 行）`；最后一页写 `共 N 页，当前第 X 页，最后一页` |
| 续页 | 传回 `ref` + `page=2`。**不要重传 url**：服务端从缓存切片，不发第二次请求 |

页脚必须写在正文里（而不是只做一个字段）：模型读到哪句，"还有没有"就在哪句旁边，
它不需要回头数 `page.total` —— 数错了就会在"已经读完"的时候反复取页。
页码越界不报错，夹到有效范围 + `notice` 说明。

#### 3.17.3 缓存：抓一次，翻页只切片

- **进程内** LRU + TTL（`WebCache`：24 条 / 24M 字符双上限，TTL 默认 10 分钟）；
- `ref = sha1(工具 + 方法 + 地址 + body + pageLines) 前 12 位` —— 同一份请求同一个 ref，
  模型重复调同一个 url 也命中缓存；
- 入缓存时算一次分页边界（`bounds`），取页 O(1)，不复制全文；
- 过期 / 重启后 ref 失效 → 明确说"缓存里已经没有它了，重新传 url 抓一次"，
  而不是静默给空内容。

#### 3.17.4 出网层（`tools/web/http.ts`）：三件事只有一处

| 点 | 落法 | 为什么 |
| --- | --- | --- |
| 身份 | 固定浏览器 UA（Chrome / Windows）+ `Accept` / `Accept-Language` / `Sec-Fetch-*` / `sec-ch-ua` | 几个工具分头写必然漂移；缺客户端提示会被有 WAF 的站点直接 403 |
| 预算 | 超时（默认 20s）+ 字节上限（默认 2MB，流式读到上限即 `cancel()`） | `res.text()` 会把 500MB 的文件或不会结束的 SSE 流整个读进内存 |
| 内网闸 | 协议白名单 + 主机名后缀 + **DNS 解析结果逐地址校验**（`10/8`、`172.16/12`、`192.168/16`、`127/8`、`169.254/16`（云元数据）、`::1`、`fc00::/7`…） | 网页内容可以诱导模型去请求 `169.254.169.254`，这是 SSRF 的常规入口 |

重定向逐跳校验（每一跳都重新解析并判内网），不是只判第一次；UA 与请求头只在**真正出网**
那一层加，工具层不各写一份。

#### 3.17.5 配置项（`agent` 命名空间 → `.env`，两层开关）

```bash
AGENT_WEB_ENABLED=true                        # 关掉后工具仍在，但每次调用返回"已关闭"
AGENT_WEB_TIMEOUT_MS=20000                    # 单次请求总时长（默认值与硬上限）
AGENT_WEB_MAX_BYTES=2097152                   # 单次最多读多少字节（硬上限）
AGENT_WEB_ALLOW_PRIVATE_NETWORK=false         # 内网 / 回环默认拦截（SSRF）
```

部署边界是**硬闸**：env 没开内网，后台把工具配置里的同名字段打开也不生效。
搜索复用 DeepSeek 官方模型密钥（当前会话模型是 DeepSeek 官方时），也可在工具配置里显式给
`web-search` 的 API Key；两者都没有时 `precheck` 给出"先用 web-fetch 读已知来源"的结论。

#### 3.17.6 不做的事（明确划出去）

- 不做浏览器渲染（没有 JS 执行 / 截图）：要读 SPA 请用接口或站点兜底表；
- 不做登录态注入（cookie 只由工具配置显式给，不自动带用户会话）；
- 不做全站爬取 / 递归抓取：这是"模型按需读一页"，不是爬虫；
- 不做 PDF / 二进制解析：那是附件链路的事（§3.16），联网工具只处理文本与 HTML。
