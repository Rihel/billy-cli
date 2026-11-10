# AI 扩展点：加 agent / 工具 / 技能 / 子 agent

> 本文件是 `develop-ai-agent` skill 的组成部分。设计依据见 `docs/design/ai-agent.md` §1、§3.14。

## 1. 加一个工具（工具组：一个方法一个工具）

适用：模型可调用的任何能力（业务模块操作、跨业务的运行时能力都是**同一套写法**）。
**先找组**：能放进已有工具组就加一个方法；没有合适的组就新建一个组类。五步：

1. 在 `core/tools/tool-keys.ts` 的 `TOOL_KEYS` 加一个 key（**不写裸字符串**：写错 key 是编译期错误）；
2. **组类**（新建组才要）：写 `@Injectable()` 类放 `tools/**`（具体工具按能力分组，如 `tools/planner/planner.tools.ts`），
   类上 `@ToolGroup({ category?, scope?, child? })` 给组内共同默认值；构造器 `@Inject` 依赖
   （业务 service / 仓储 / `AgentRunner` / 日志）—— 组内工具共享，与业务接口同一条 IoC 链路；
3. **方法 + 方法级 `@ToolDecl({ key, title, description, params, config, ... })`**：一个方法就是一个工具；
   `params` / `config` 用**同一文件里的模块级 zod 常量**（装饰器在类定义期求值，不能引用本类 static），
   `config` 每个字段都要 `.default()`，`description` 写"是什么 / 什么时候用 / 什么时候不用 / 纪律"；
4. **钩子按方法名写在声明里**：`precheck: 'checkXxx'` / `normalize: 'normalizeConfig'`（被指向的方法写成
   组类普通方法）。**执行体只写业务动作** —— 开关、边界、分页、审计都在网关插件里；
5. **装配与测试**：新组才要在 `ai.module.ts` 的 `AGENT_TOOL_GROUPS` 工厂登记一行（`providers` 里也加一行）；
   需要的 agent 声明里授权该 key，并写 `test/ai-tools/<key>.test.ts`
   （标准测试集强制：`specByKey(new XxxTools(...), key)` 拿 spec 直接调 `exec`）。

入参定义用 zod 写**给模型看的说明**（`.describe()`）；执行体出参**原样返回、不裁剪**（运行时会把完整出参落时间线）。
子 agent 不能用的标 `child: 'deny'`；委派类标 `delegation: true`（子 agent 工具面 = 全部 − 委派类 − deny）。
**一个类一个工具 = 组里只有一个方法**：形状只有一种，不必为"单工具"另写。

## 2. 跨业务的运行时能力（原「core bean」）

规划 / 子 agent / 取页这些**跨业务**的运行时能力**已不再有单独的 core bean 层**：每个能力就是一个工具组
（写法同上，放 `tools/**`；规划四个工具就是 `PlannerTools` 组内的四个方法），依赖走构造器注入。共同点：

- **不要注入 `ToolRegistry`**（会成环）：需要"全部工具"之类的信息，让编排层算好、经 `requestContext` 的
  **运行时信封**传进来（见 §3）；
- **能力有基础设施底座时，机制放 `packages/kits`**：一个能力一个 `foundation/<name>/` 目录 +
  `@Global()` 模块，工具组只写策略（开关 / 边界 / 上限）与结论映射 ——
  参考 `RunCommandTool`（`tools/command.tool.ts`）+ `kits/src/foundation/command/`（跨平台命令执行，底层 execa）。

## 3. 运行时信封（工具怎么知道"我在哪一轮"）

编排层（`AgentChatService.buildRuntimeContext`）在发起一轮时把信封塞进 Mastra `requestContext`：
`{ conversationId, parentRunId, triggeredBy, depth, model, childTools, childSkills, environment?, abortSignal? }`
（`model` 是这一轮从库里解析出的模型；`environment` 只在会话首轮有值，见 §8）。

工具侧只读四样（都在 `ToolExecutionContext` 上，已核实）：
`requestContext`（信封）/ `agent.toolCallId`（幂等键）/ `writer`（写 `data-*` 到父流）/ `abortSignal`（停止传播）。

## 4. 加一个顶层 agent（`ai/agents/*.agent.ts`）

1. 一个声明文件（`AgentSpec`：key / name / description / tools / skills / prompt）；
2. 在 `agents/index.ts` 的 `AGENT_SPECS` 加一行；
3. 加 `prompts/templates/<模板>.eta`。**所有提示词只走引擎**：`{{= }}` 插值、`{{~ include('partials/x') }}` 复用，
   "可用工具"那段由 `ToolRegistry.describe(spec.tools)` 渲染 —— 提示词里的工具清单与实际挂载的**同源**，
   key 写错在启动期就报错。

`tools` 除了具体 key / `'*'`，还能写结构化选择器：`{ category: 'business' }`、
`{ connector: 'prod-pg' }`、`{ connector: 'prod-pg', tool: 'query' }`。
**裁剪思路与授权三层**见 [define-agent.md](./define-agent.md)。

## 5. 加一个技能（三种入口，别混）

| 用途 | 放哪 | 谁读 |
| --- | --- | --- |
| 给**写代码的 agent** 的工程规范 | 仓库 `.agents/skills/<name>/SKILL.md` | 编码 agent（Claude Code / DSH），按 `manage-skills` 维护 |
| 给**运行时助手**的业务技能（在线写 / 贴 skills.sh 或 GitHub 链接装 / agent 自己写） | **技能库**：后台 `/main/ai/skills`、`/ai-skill/*` 或 `skill-save` 工具 → DB → 落盘 `<skillsLibraryDir>/<name>/` | `SkillLoader` → 交给 Mastra |
| 随部署打包 / 外部技能库 | `core/skills/catalog/<name>/`（严格校验）或 `AGENT_SKILLS_DIRS`（默认 `~/.agents/skills`，坏一个跳过） | `SkillLoader` → 交给 Mastra |

**技能库（推荐，在线改不用重启）**：`SKILL.md` = frontmatter（`name` 唯一、`description` ≤1024）
+ 正文 + `references/` / `scripts/`；页面用块编辑器写正文，frontmatter 走表单。
写链路是「校验 → 事务写库（乐观锁）→ 落盘 → `SkillLoader.reload()`」，DB 是事实源，
落盘目录只是给 Mastra 的投影。**停用会删落盘目录**（目录才是模型的权限边界）。
agent 声明里 `skills: ['*']` 在**每次运行**现算，所以新建 / 停用不用重启。
**从链接装**：`/ai-skill/import/preview` → `/ai-skill/import`（或 `skill-import` 工具），
支持 skills.sh 技能页、GitHub 仓库/目录/文件链接与 `owner/repo` 简写；下载内容进库，不是登记链接。
解析用 `parse-github-url` + `@octokit/rest`（GitHub 树 + raw 文件），不依赖 skills.sh 的 OIDC API。
设计见 `docs/design/ai-skill-library.md`，落点与坑见 memory `ai-skill-library`。

随包 / 外部目录的技能仍是"启动时扫名单、正文 Mastra 按需读盘"；改名单要重启。
注意：`core/skills/catalog/` 目前**不存在**。

## 6. 子 agent（动态创建，不是静态声明）

- 子 agent **不在注册表里**：主 agent 调用 `run-sub-agent` 工具，运行期现场创建（跑完即弃）；
- 入参三件套：`name` / **`system_prompt`（主 agent 现写，必填）** / `task`；
- 工具面 = **父 agent 的授权面 ∩（全部 − 委派类 − `child: 'deny'`）**
  （"子助手有你的全部工具"里的"你的"= 父 agent 被授权的那一份，不是注册机全量；于是子 agent 也不能再造子 agent）；
- 明细全部入库：独立 `runs` 行（`parent_run_id` / `depth` / `tool_call_id`）+ 自己完整的 `timelines`，
  动态提示词与任务全量落 `request_snapshot`；
- **父的 `usage` 汇总子的消耗**（`usage.subAgents`），但 `step_count` / `tool_call_count` 各记自己的；
  轮数只数根 run；
- 配额：`subAgentMaxPerRun`（默认 4）/ `subAgentMaxDepth`（1）/ `subAgentMaxSteps` / `subAgentTimeoutMs`；
  超限**不抛异常炸整轮**，把原因作为工具结论返回给模型；
- 幂等：同一 `(parent_run_id, tool_call_id)` 已成功过 → 复用上次结论（不重跑、不重复扣费）。

## 6.5 AI 模型与供应商（表已落地，模块待做）

`ai_providers`（供应商接入：kind / base_url / 密钥密文 + 提示 / 启停 / 同步状态）与
`ai_models`（模型：`model_key` / 展示名 / 窗口 / 能力 / 来源 / 启停 / `raw` / `last_seen_at`）
两张表已落地（实体 + 迁移 + 对外模型），**CRUD / 同步接口 / 管理页尚未实现**。
改这块之前先读 `docs/design/ai-agent.md` §4.8（含三家供应商"列模型"接口的形态、同步语义、
密钥加密口径），别在别处另起一套。两条容易踩的：密钥只进不出（明文永不落库/回传）、
两张表的唯一索引是**软删感知**的（`WHERE deleted_at IS NULL`）。

## 7. 数据结构、SDK 与前端

- 数据结构加在 `packages/shared/src/schema/agent.schema.ts`，**改完必须 `pnpm build:pkgs`**；
- SDK 的 typed 方法在 `packages/sdk/src/server.client.ts` 的 `agent` 分组（含 `chatStreamUrl` /
  `resumeStreamUrl` / `authHeaders` 三个给 AI SDK 用的旁路）；
- **会话维护类接口**（前端会话页用）：`conversation/rename`（手动改名，会记一条 `status` 审计事件）、
  `conversation/remove`（软删，**唯一删除入口**）、`instructions`（带 `conversationId` 回该会话
  **渲染后的系统指令快照**，不带则回静态定义；`source` 字段标明来源，未知 agentKey 抛 3303 不回落）；
  侧栏行操作（改名 / 删除）要放在 `<Link>` 的**兄弟节点**上。
- 前端页面：web `apps/web/src/app/ai/chat`（useChat + ai-elements，渲染每个 part），
  审计页 admin `apps/admin/src/app/main/ai/audit`（会话 → 运行树 → 时间线 + 输入快照）。

## 8. 首轮运行环境注入（操作系统 + 当前时间）

需求口径：**系统指令告知 agent 是什么操作系统、当前日期时间**（设计文档 §3.15.4）。

- **组装**：`prompts/environment.ts` 的 `buildEnvironmentData(now?, platform?, timeZone?)` ——
  三个入参都可注入，所以可单测（跨平台代码只在本机跑过 = 另外两端没测）；
- **模板**：`prompts/templates/partials/environment.eta`（提示词文本只走引擎，不手拼字符串）；
- **渲染时机**：`AgentChatService.renderEnvironment(conversation)`，只在 `turnCount === 0`（会话第一轮）
  渲染 —— 系统提示词是请求前缀，每轮换时间戳会把提供方的前缀缓存打掉；
- **怎么进提示词**：渲染结果放进运行时信封的 `environment` 字段，由 `ai.mastra.ts` 的
  `instructions` 动态参数追加到基础提示词后面（拿不到信封就用基础提示词，**不能抛错**：
  Mastra 构造 durable agent 时会不带 requestContext 求值一次）；
- **引擎怎么拿到**：`PROMPT_ENGINE` token（`ai.module.ts` 用 value provider 注入）；
  按轮求值的片段走 `promptEngine.renderPartial(template, data)`（`render` 的 `PromptData` 要求
  `agentKey` / `tools` 那套字段，不放宽它，否则"工具清单忘了注入"就没人拦）；
- **子 agent 不注入**：它的提示词由主 agent 现写，`request_snapshot` 要保持原样。

## 9. 加一个连接器（外部能力来源）

**别用工具组写外部集成**——连接器是数据 + 驱动的组合，工具由连接器同步产生。两条路：

1. **只加实例**（不改代码）：后台「AI → 连接器」→ 选型号 → 填地址/账号 → 测试 → 同步；
2. **加新型号/驱动**（改代码）：
   `connectors/connector.catalog.ts` 加目录条目（必须给 `defaults`，如 `dialect` / 默认端口）→
   `connectors/drivers/<name>.driver.ts` 实现 `describe / invoke / probe`（禁 import `@mastra`）→
   `ai.module.ts` 的 `providers` 与 `CONNECTOR_DRIVERS` 各加一行 → `test/ai-connector.test.ts` 补断言。
   **命令行型驱动**（样板 `drivers/lark-cli.driver.ts` + `.policy.ts`）：能力面只出一个受限 `run`，
   参数数组 `spawn` 直跑、不走 shell（detached 进程组，超时/取消按组杀）；白名单写纯函数（禁 `--profile` / `--yes` / 管理命令）；
   每实例独立 `HOME`、子进程环境变量走白名单；CLI 由 `docker/Dockerfile.server` 预装，驱动不做运行期安装。

四条硬口径：工具 key 前缀 `c-<实例>-<工具>`、追溯只认 `connector_id`；连接器工具默认 `scope='admin'`；
密钥在实例上（`connector-guard` 会嫁接进工具设置，precheck / 脱敏才正常）；驱动异常统一 `upstream`。
完整步骤与验证清单见 `docs/design/ai-extension-guide.md` §3，设计与取舍见 `docs/design/ai-connector.md`。
