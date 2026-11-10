---
name: develop-ai-agent
description: >-
  在 Billy 工程（billy-cli）中开发 / 扩展 AI 能力（`apps/server/src/modules/ai`）：新增 agent、
  新增工具（**工具组 + 方法即工具**：`@ToolGroup` + 方法级 `@ToolDecl` + 注册机 + 网关插件；规划 /
  子 agent / 取页）、工具配置入库与后台配置页、Mastra 适配器边界、
  新增技能（SkillLoader catalog）、写提示词（eta 模板）、改会话 / 运行 / 时间线落库与 SSE 流式协议、
  动态子 agent、上下文裁剪与压缩、崩溃恢复与看门狗。触发词：AI、agent、agent key、工具、
  tool、工具组、@ToolGroup、@ToolDecl、装饰器、ToolSpec、ToolRegistry、注册机、ToolGateway、网关、插件、plugin、
  工具自定义事件、事件声明、ctx.emit、data-tool-event、事件渲染器、
  ai_tools、工具配置、planner、子 agent、sub-agent、技能、skill、提示词、prompt、eta、
  会话、conversation、run、运行、时间线、timeline、流式、SSE、AI SDK、Mastra、token 消耗、
  上下文压缩、恢复、看门狗。
---

# 开发 AI 能力（`modules/ai`）

前置：先加载必读 skill `billy-dev-foundation`；数据结构改动配合 `define-data-structure` /
`database`，接口质量自查看 `develop-backend-api`，写页面看 `develop-frontend-page`。
**分工**：本 skill 讲**怎么写**（机制与配方）；**该不该做、工具面怎么切、权限与成本、安全与审计、
怎么验收**看工程级 skill `ai-agent-engineering`。
**权威设计文档**：`docs/design/ai-agent.md`（运行时）+ `docs/design/ai-agent-tool-engine.md`
（工具 DSL / 注册机 / 网关插件 / 配置入库 / Mastra 适配器）+ `docs/design/ai-connector.md`（连接器）——
改 AI 前先读，改完同步。**加工具 / 加技能 / 加连接器的落地步骤**统一看
`docs/design/ai-extension-guide.md`。

## 0. 四条硬规则（违反即返工）

1. **不加物理外键**（全工程唯一硬规则，`runs` 的自引用更不行）；
2. **`runs` / `timelines` 永不删除**（审计证据）——只有**会话**能删，且只能软删；
3. **工具入参出参、子 agent 的动态提示词与任务、摘要正文一律全量入库**，不裁剪
   （分页只改"给模型的那一份"，靠 `toModelOutput`，返回值仍是全量）；
4. **术语固定**：轮（turn）= 一次问答 = 一个**根 run**；步（step）= 一次模型调用；
   「回合」已弃用；对外标识统一叫 **agent key / tool key**（不叫 agentId）。

## 1. 模块地图

| 目录 | 放什么 | 加东西时改哪 |
| --- | --- | --- |
| `api/` | **接口层**：`ai.controller`（对话路由）/ `ai-tool.controller`（工具配置路由）/ `ai-tool.service`（后台工具配置服务） | 加路由：写 controller + 在 `ai.module.ts` 的 `controllers` 登记一行 |
| `core/` | **核心引擎**（与"具体是哪件事"无关）：共享数据结构 `envelope`（运行时信封）/ `config` / `constants` / `errors` / `model-decision`；**工具引擎 `core/tools/**`**（`tools.types` DSL / `tool.decorator` + `tool.class`（工具组 DSL 与 `buildToolSpecs`）/ `tool.registry`（注册机 + 种子）/ `tool.gateway`（网关）/ `plugins/*.plugin.ts`（一个插件一个文件）/ `tool.settings`（合并纯函数）/ `tool.config.service`（缓存）/ `tool.config.repository`（`ai_tools`）/ `tool-event`（事件声明归一化 + 发射，见 §2.2）/ `paginate` + `tool-result.store`（大返回分页与回取））；`core/skills/**`（`SkillLoader` + `catalog/<name>/SKILL.md`；当前仓库未建 catalog，默认加载 `~/.agents/skills`）；`core/prompts/**`（提示词引擎 + `templates/*.eta` + `partials/` + 运行环境组装 `environment.ts`） | 加引擎能力：改 `core/tools/**`（**禁 import `@mastra`**） |
| `runtime/` | 会话 / 运行 / 时间线仓储与服务、上下文、**附件取回与多模态组装**（`chat-attachment.service`）、流记录、子 agent 执行器、崩溃恢复 + `plan.protocol`（计划协议） | 改行为先看 `runtime.md` |
| `agents/` | **顶层** agent 声明（前端能选的就这些，一个文件一个）+ `index.ts` 唯一登记处 + `types` / `registry` / `service`（注册表与装配查询） | 加 agent：一个文件 + `AGENT_SPECS` 一行 + 一个 eta 模板 |
| `tools/` | **具体工具**（用 `core/tools` 的引擎写，**禁 import `@mastra`**）：`command.tool` / `subagent.tool` / `read-tool-result.tool` / `planner/**`（规划工具组 `planner.tools`：组内四个 `@ToolDecl` 方法 + `planner.store` 机制 + `planner.schemas` 数据结构） | 加工具：在合适的组里加一个 `@ToolDecl` 方法（没有合适的组就新建一个 `@ToolGroup` 类）+ 在 `AGENT_TOOL_GROUPS` 登记一行 |
| `connectors/` | **连接器**（外部能力来源：目录 / 驱动 / 同步 / 后台接口；`connector.types.ts` 是抽象，`drivers/` 是接法） | 加型号：目录 + 驱动 + `ai.module` 注册；见 `docs/design/ai-extension-guide.md` §3 |
| `mastra/` | **适配器**（唯一可 import `@mastra`）：`ai.mastra`（Mastra 实例装配）/ `tool.adapter`（含 `toModelOutput` 分页）/ `agent.adapter` / `context.adapter`（信封 ↔ RequestContext）/ `stream.adapter` / `skill.adapter` | 升级 Mastra 先跑 `test/ai-mastra-contract.test.ts` 的数据结构，再改这里 |

细节：会话运行链、上下文策略、SSE 协议与恢复 → [references/runtime.md](./references/runtime.md)；
扩展点（加 agent / 工具 / 技能 / 子 agent / 连接器）→ [references/extension.md](./references/extension.md)。
**裁剪与授权**（agent 该给哪些工具、选择器、作用域三层）→ [references/define-agent.md](./references/define-agent.md)；
**连接器**（能力供给、驱动、治理、与 agent 接线）→ [references/connector.md](./references/connector.md)。

## 2. 装配方向（不许反）

```
AGENT_TOOL_GROUPS(工具组实例数组) ─→ ToolRegistry（buildToolSpecs() 拍平成一张 key→声明表，
                                     一个组 1..n 个工具；重复 key / 组内没有 @ToolDecl 方法 / 默认值没给全 → 启动即失败）
                                            ↑ 每个工具经 ToolGateway 包装（pre 9 个插件 → exec → post 3 个）
工具组 ──→ 仓储 / AgentRunner / 配置      （**不注入注册机**，否则成环）
编排层（AgentChatService）──→ 把"子 agent 能用什么工具"经运行时信封传进工具
ai/mastra/** 适配器 ──→ Toolbox/SkillRef/信封 映射成 Mastra 的 ToolsInput/InlineSkill/RequestContext
```

`ai.module.ts` 是唯一装配处：新增工具都要在那里登记一行（显式的代价换来一目了然）。

**目录分层（依赖方向单向）**：`api/` → `agents/` → `core/`；`tools/`（具体工具）→ `core/tools` + `runtime/plan.protocol`；
`core/tools`（引擎）**不许**依赖 `runtime/`、`agents/`、`tools/`、`api/`。

**两个只在启动时才暴露的坑**（各踩过一次，`test/app-bootstrap.test.ts` 现在守着）：

1. `exports` 里写了一个没在 `providers` 里提供的 token → `UnknownExportException`（类型检查与单测都发现不了，
   因为单测是手工 `new` 的）；
2. **工厂型 provider 成环 → Nest 不报错、直接静默死锁**（现象：进程 CPU 0%、永远停在启动中）。
   踩过的那条环是 `ToolRegistry → AGENT_TOOL_GROUPS → RunSubAgentTool → AgentRunner → ToolRegistry`；
   解法是让 `AgentRunner` 用 `ModuleRef` **惰性取**注册机（`this.moduleRef.get(ToolRegistry, { strict: false })`），
   构造期不依赖它。要读容器的类一律照这个办法。

## 2.1 如何新增一个工具（工具组：方法即工具）

> **交互原语例外**：`ask-user-questions`（向用户提问、挂起、回答后续跑）不是业务工具，
> 走 Mastra 原生 `suspend()` / `resumeStream()`，放 `mastra/`、只给主 agent，**不经过**
> `@ToolGroup` 注册机与网关（网关会把异常都转成工具失败，而 suspend 是控制流）。
> **取消整组回答**也走 `resumeStream({ cancelled: true })`（resumeData 进 `resumeSchema`）：
> `declineToolCall()` 只对 `requireApproval` 的审批挂起有效，对 `suspend()` 不适用。
> 设计见 `docs/design/ai-agent.md` §3.7.1；普通能力仍按下面工具组写。

**先找组**：能放进已有工具组就加一个方法；没有合适的组就新建一个组类
（具体工具与工具组都放 `tools/**`，按能力分组，如 `tools/planner/planner.tools.ts`）。

1. **组类**（新建时才要）：`@Injectable()` 类 + 类上 `@ToolGroup({ category?, scope?, child? })`
   给组内工具共同默认值；依赖（仓储 / 执行器 / 日志）**全部走构造器 `@Inject`**，组内工具共享；
2. **方法 + 方法级 `@ToolDecl({...})`**（**一个方法 = 一个工具**，声明与执行体同一处）：
   `key` 取自 `TOOL_KEYS`（先在 `core/tools/tool-keys.ts` 加一个 key）；`params` / `config` 用**同一文件里的
   模块级 zod 常量**（不能引用本类 static —— 装饰器在类定义期求值）；`config` 每个字段都必须 `.default()`；
   `description` 写"是什么 / 什么时候用 / 什么时候不用 / **自己特有的约束**"——
   **共性纪律与"为什么"都不写进工具说明**（纪律统一放 `partials/principles.eta` 的全局纪律段，
   理由放设计文档）：工具说明是每轮请求的前缀，标准测试集有 `≤380 字符` 的体量护栏；
3. **钩子按方法名写在声明里**：`precheck: 'checkXxx'`（只读前置条件）/ `normalize: 'normalizeConfig'`
   （把配置夹到部署上限）；被指向的方法写成组类的普通方法。执行体只写业务动作 —— 开关、边界、分页、
   审计都在网关插件里；
4. **装配**（新建组才要）：`ai.module.ts` 的 `AGENT_TOOL_GROUPS` 工厂 `inject` 里加这个组，
   并在 `providers` 里加一行；子 agent 不能用的在 `@ToolGroup` / `@ToolDecl` 标 `child: 'deny'`，
   委派类标 `delegation: true`；
5. **测试与授权**：写 `test/ai-tools/<key>.test.ts`（标准测试集强制：`specByKey(new MyTools(...), key)`
   或 `buildToolSpecs(group)` 拿 spec 直接调 `exec`），并在 `agents/assistant.agent.ts` 的授权清单加 key。

**`reason` 不用你写**：每次调用必填的"为什么用这个工具"由**引擎注入**（`core/tools/call-reason.ts` 的
`withCallReason`，`buildToolSpecs` 组装声明时统一包成 `modelParams`）。它只作用于"给模型的 schema +
网关校验"这一层，执行体拿到的 `input` 仍是你的原定义（`reason` 被 `ValidatePlugin` 摘掉；
要写业务日志就读 `ctx.reason`，可选、不要求）。设计见 `docs/design/ai-agent-tool-engine.md` §5.18。

**一个类一个工具 = 组里只有一个方法**：形状只有一种，不必为"单工具"另写。

```ts
const GreetInput = z.object({ who: z.string().describe('打招呼的对象') })
const GreetConfig = z.object({ enabled: z.boolean().default(true) })

@Injectable()
@ToolGroup({ category: 'core', scope: 'all' })
export class MyTools {
  constructor(@Inject(SomeService) private readonly service: SomeService) {}

  @ToolDecl({ key: TOOL_KEYS.myFirst, title: '第一个工具', params: GreetInput, config: GreetConfig,
    description: dedent`是什么 / 什么时候用 / 什么时候不用 / 纪律都写这里`, precheck: 'checkWho' })
  async first(input: z.infer<typeof GreetInput>, ctx: ToolCallContext<z.infer<typeof GreetConfig>>) {
    return this.service.do(input.who, ctx.settings.config)
  }

  @ToolDecl({ key: TOOL_KEYS.mySecond, title: '第二个工具', params: GreetInput, config: GreetConfig,
    description: dedent`...` })
  async second(input: z.infer<typeof GreetInput>, ctx: ToolCallContext<z.infer<typeof GreetConfig>>) {
    return this.service.other(input.who)
  }

  checkWho(input: z.infer<typeof GreetInput>): string | null {
    return input.who ? null : '要说明和谁打招呼'
  }
}
```

## 2.2 如何让工具往流里发事件（自定义事件 DSL）

工具除了给出参，还能在**执行过程中**往这条流里发事件，让前端实时渲染（进度、阶段、产物行……）。
声明与发射都在同一个 `@ToolDecl` 上：

```ts
const RunEvents = [
  { name: 'progress', title: '执行进度', mode: 'state',
    description: dedent`每完成一个阶段发一次；percent 是 0-100 的整数，stage 是当前阶段的中文名`,
    payload: z.object({ percent: z.number(), stage: z.string() }) },
  { name: 'artifact', title: '产物', mode: 'stream',
    description: dedent`每写出一份产物发一条；url 可直接展示`,
    payload: z.object({ url: z.string(), label: z.string() }) },
] as const

@ToolDecl({ key: TOOL_KEYS.myFirst, title: '...', params: GreetInput, config: GreetConfig,
  description: dedent`...`, events: RunEvents })
async first(input: z.infer<typeof GreetInput>, ctx: ToolCallContext<z.infer<typeof GreetConfig>>) {
  ctx.emit('progress', { percent: 30, stage: '读取' })   // 执行过程中随时发
  return this.service.do(input.who, ctx.settings.config)
}
```

五条口径（细节见设计 §5.17）：

1. **`mode` 决定前端看到什么，由服务端定**：`state`（默认）= 带稳定 id
   `<toolCallId>:<事件名>`，AI SDK 按 id 归并（同 id 后者覆盖前者）→ 前端**只看到最新快照**
   （进度不刷屏）；`stream` = 不带 id，一块一条 → 前端按序追加（日志行、产物行）。
   前端**不自己实现去重**，只按 `parts` 顺序遍历。
2. **未声明不许发**：`ctx.emit` 只认声明里的 `name`（组内唯一）；未声明、或 payload 不合声明的
   zod 定义 → **丢弃 + `log.warn`**。事件是锦上添花，**绝不能让工具执行失败**。
3. **事件是过程，出参是结论**：事件只走流，**不落时间线**（`stream-recorder` 的 `default` 分支）；
   刷新后还要看见的东西**必须写进出参**（出参全量落库）。这是口径不是 bug。
4. **声明是基础信息**：`events` 与 `title` / `description` / `param_schema` 一样启动期镜像进
   `ai_tools.events`，后台工具页只读展示（前端只配 config / limits / secrets）。
5. **前端渲染是代码注册的**：认不出的事件走内置兜底（标题 + 事件名徽标 + 折叠 JSON，绝不静默丢）；
   要自定义外观就在 `apps/admin` 侧 `registerToolEventRenderer(toolKey, event, renderer)`
   （优先级：精确 > 工具通配 > 全局精确 > 全局通配 > 兜底）。

**非流式 / 后台调用没有 writer，`ctx.emit` 是安全 no-op** —— 所以业务事实不能只放在事件里。

**目前没有生产工具在发事件**（`run-command` 曾按行发过 stdout / stderr + 一个 exit 状态块，
2026-10-01 **按用户口径移除**：它把出参里已有的内容又放了一遍，命令通常一两秒就结束，逐行只剩闪烁，
还把消息撑长）。**声明事件之前先答一句**：过程信息本身有没有独立价值（时长很长、用户会在等待中做判断）？
"把出参提前展示一遍"不算价值。真要做时照 §2.2 的骨架写，前端**无需改代码就有兜底渲染**
（标题 + 事件名徽标 + 折叠 JSON）；要终端 / 图表这类外观再写 `registerToolEventRenderer` 并在会话页
模块加载期 import。机制本身的测试与设计见设计文档 §5.17。

## 3. 验证与质量检查

```bash
pnpm --filter @app/server test test/ai-plan-subagents.test.ts   # 规划 / 子 agent / 审计
pnpm --filter @app/server test test/ai-tools-battery.test.ts    # 注册机标准测试集（每个工具）
pnpm --filter @app/server test test/ai-mastra-contract.test.ts  # 适配器行为约定（升级 Mastra 先跑）
pnpm --filter @app/server test                                  # 含真实 Redis 的流式 e2e
pnpm typecheck && pnpm test && pnpm check:ui && pnpm check:inject && pnpm check:mastra   # 全仓检查
```

**两条规定（工具引擎按它写，别的包同样适用）**：文字性多行字符串一律 ``dedent`...` ``；
除纯类型文件外**一个文件一个职责**（见 `billy-dev-foundation/references/code-conventions.md` 第 11 / 12 条）。

**带装饰器的测试夹具只能放 `src/**`**：`test/**` 下的文件 Vitest 不做 TS 装饰器转换
（`SyntaxError: Invalid or unexpected token`，`test/helpers/` 与 `*.test.ts` 内联类都失败，
加 `esbuild.tsconfigRaw.experimentalDecorators` 也无效；无装饰器的测试文件正常）。
需要 `@ToolGroup` 声明的测试工具组放 `src/modules/ai/tools/*testkit*.ts`，**不进 `AGENT_TOOL_GROUPS`**，
并靠 `tsconfig.build.json` 的 `**/*testkit*.ts` 排除出构建产物（生产误引则构建失败）。

## 4. 工具配置的三条口径（2026-10-01 定，改之前先看）

1. **基础信息留在代码、启动期全量镜像入库**：`title` / `description` / `category` / `param_schema`
   / `events`（自定义事件声明，见 §2.2）由 `ToolSeedService` 每次启动按声明**覆盖写**（代码是唯一事实源）；
   后台页只读展示，**不提供编辑**。
2. **前端只配"配置"**：可改的只有开关 / 作用域 / 限额 / 配置值 / 秘钥；`config` 与 `limits` 是
   **整列替换**（jsonb 不按 key 合并），所以前端提交"整份生效配置"。
3. **秘钥明文入库**（含 `ai_providers.api_key`）：没有加解密，提示串由 `hintOf` **读取时派生**；
   接口不回明文，日志与出参靠 `redact` 插件脱敏。代价：**库泄露即密钥泄露** —— 这是明确的取舍，
   不是疏漏（改回去要同时改实体、迁移与 `secret-hint.ts`）。

## 5. 规划能力是一组四个工具（不是单个写清单工具）

`plan-create`（创建，已有清单时=追加）/ `plan-reorder`（重排 + 就地改标题·备注·状态，**开始做某一项也用它**）/
`plan-complete`（批量完成）/ `plan-delete`（批量删除）。

三条改它之前必须知道的：
- **出参永远是完整清单快照**（`{goal, revision, tasks, summary, warnings?}`）→ 每个工具都会落一条 `plan`
  时间线事件，「当前计划」= 最后一条（`runtime/plan.protocol.ts` 的 `PLAN_TOOL_KEYS` 要跟着登记新 key）；
- **四个都 `child: 'deny'`**（只给主 agent），内部共享"本轮内存 → 时间线 + 同轮串行 + 失败不改内存"的机制；
- 加第五个规划工具时：`core/tools/tool-keys.ts` 加 key → `PLAN_TOOL_KEYS` 登记 → 在 `PlannerTools` 里加一个
  `@ToolDecl` 方法（`PlannerStore` 已在组构造器注入）→ `assistant.agent.ts` 授权 → `test/ai-tools/<key>.test.ts`（标准测试集强制）。

- **离线 mock 模型**在 `test/helpers/mock-model-server.ts`（`[todo-overwrite]` / `[todo-react]` /
  `[delegate]` / `[command]` / `[slow]` 标记），
  不需要任何外部密钥；新增能力优先给它加一个标记 + 一条端到端断言；
- 改数据结构（`@repo/shared`）后**必须** `pnpm build:pkgs`，否则 `@repo/*` 仍解析 dist；
- 迁移：`pnpm --filter @app/server db:generate <名字>` → 迁移文件首行改 `import type`，
  并**人工检查部分索引（partial unique）的条件变化**（TypeORM 检测不到）。
