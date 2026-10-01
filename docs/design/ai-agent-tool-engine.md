# Agent 工具引擎：背景、痛点与实施方案

> 给 agent 工具加一层我们自己的管理面：工具用声明式结构定义（名称 / 描述 / 参数 / 配置），
> **基础信息留在代码、启动期全量镜像入库**，**配置**（开关、秘钥、限额）进数据库并有后台页面可改
> （**秘钥明文入库**，2026-10-01 决定），所有工具调用统一过一个网关做前置校验、权限判断、分页与审计；
> Mastra 通过适配器接入，我们的工具代码里不出现它的类型和词汇。
> 每个工具与每个插件都要能脱离模型、数据库、Redis 单独跑单测（§5.9）。
>
> 状态：**一期（批次 0–4）已实施**。本文档保留设计原貌，实施中的偏差与补充见文末「实施记录」。
> 相关文档：`docs/design/ai-agent.md` §1.2、§3.14、§3.15。

## 1. 背景

### 1.1 工具现在是怎么接进来的

```
AGENT_TOOLS（业务工具 bean，目前为空）┐
                                      ├→ ToolBuilder：拍平成 key→工具表，重复 key 启动即失败
AGENT_CORES（core bean.asTools()）───┘        │
                                              ├→ describe()  给提示词的《工具》段
                                              └→ build() / buildDelegable() → Mastra
                                                        │
                                     ai.mastra.ts:103  tools: resolveTools(definition.tools)
                                                        ▼
                                                   Mastra Agent → 模型
```

工具池里现在有 7 个，都由 core bean 提供：规划一组四个（`plan-create` / `plan-reorder` / `plan-complete` /
`plan-delete`）、`run-sub-agent`（子 agent）、`run-command`（命令行）、`read-tool-result`（大结果取页）。
业务工具一个都没有，`AGENT_TOOLS` 是留出来的扩展点。

三个 core bean 的写法一样：构造器里手动调 `createTool({ id, description, inputSchema, execute })`，
说明文本、入参 schema、执行体、开关判断、边界检查全写在同一个文件里。
`run-command`（`core/beans/command.core.ts`，215 行）是典型：工具说明占 24 行，`execute` 里前 30 行做开关、
目录边界、时长夹紧，剩下的才是"跑命令"这件事本身。

### 1.2 三条现状约束

这三条不是设计偏好，是代码和依赖的既有行为，方案必须按它们来。

| 约束 | 依据 | 后果 |
| --- | --- | --- |
| 工具清单在 `new Agent()` 时一次性交给 Mastra | `mastra/ai.mastra.ts:103` | 运行期只能拦掉调用，不能靠"不让模型看见"实现权限 |
| durable（崩溃恢复）默认开启 | `app-config.ts:134` | 引擎必须走 durable 也成立的路径 |
| durable 路径直接调 `tool.execute`；**agent 级 `beforeToolCall` 仍然生效且能短路**（钩子在 Agent 层包装工具实例，不走 durable 文件） | `create-durable-agent-*.js:4576` 直接调 `execute`；**实测**（`test/ai-mastra-contract.test.ts` 契约 ②）：钩子被调用，`{proceed:false, output}` 能短路且结论交给模型 | 钩子是可用选项；我们仍选择包 `execute`，让网关与插件不必认识 Mastra 的钩子 API（主体框架无关） |

另有一条落库规则要一起考虑：工具入参出参全量入时间线（`stream-recorder.ts:106-133` 不裁剪），
能省的只有"给模型看的那一份"（`context.service.ts:342-358` 超限截断）。

## 2. 痛点

### P1 加一个工具要抄一遍样板，改一个判断要改多个文件

现在新增工具要动 4 处登记（`tool-keys.ts` 加 key、写 bean、`ai.module.ts` 注册、agent 声明授权），
这 4 处是必要的。问题在之外的部分：`createTool` 的包装、工具说明的写法、开关与边界判断，
每个工具都要重写一遍。`run-command` 里的目录边界用 `path.relative` 判越界，
`planner` 里用 promise 链串行化同一轮的并发调用，这些经验都留在各自的文件里。
下一个工具的作者不一定知道要写，漏掉就是缺一个保护。

### P2 开关和限额在 env 里，改一次要重启

`run-command` 的四个旋钮全在环境变量（`core/ai.config.ts:55-61`）：开关、超时、输出上限、工作目录。
`app-config.ts:160-166` 是它们的 schema 和默认值。

想临时关掉命令执行，或者把超时从 15 秒放宽到 30 秒，都要改 `.env` 再重启服务。
这不是配置该有的样子：它们是运行期策略，却被当成部署参数。

### P3 工具被拒、越界、关掉，只有一行日志

`command.core.ts:124` 和 `:130` 各打一条 warn，时间线上只留下原始的 `tool-call` / `tool-result`。
“这一轮里模型试了三次命令都被拒绝”、“哪个工具最近被越界调用最多”这类问题，现在只能翻日志。
工具级的拒绝没有进审计记录，前端也看不到。

### P4 大结果被截断，模型没有别的办法

工具出参超过窗口比例对应的字符数后，给模型的那一份被截断，附一句"完整内容已入库"
（`context.service.ts:342-358`）。完整内容确实在库里，但模型读不到：它没有工具能取回后面那一段。
结果是要么在信息不全的情况下作答，要么把同一个工具再跑一遍。
对有副作用的工具（跑命令、写数据）重跑一遍，代价不只是 token。

### P5 模型调不存在的工具时，没人知道

上游已经处理了这种情况：Mastra 把 `ToolNotFoundError` 变成工具错误结果交回模型
（`agent-*.js:28445`），整轮不会失败，这一点现状是好的。但错误是英文原文，时间线里没有单独标记，
也没有计数。提示词里写了 3 个工具、模型却编出一个第 4 个，这本来是提示词或工具描述需要调整的信号，
现在它只会安静地消耗掉一步。

### P6 换一个 Mastra 版本，要动半个 AI 模块

`@mastra/*` 的 import 有 27 处，散在 16 个文件里。我们自己的领域类型本身也是 Mastra 类型的别名：
`tools/tools.types.ts:34` 的 `AgentToolInstance = ToolsInput[string]`，
`core/ai.core.types.ts:76-78` 的运行时信封里装的是 `ToolsInput` 和 `InlineSkill`。

`tool-keys.ts:4-6` 已经写过这条原则（"不把它的词引进我们的领域"），但只是写在注释里，
没有目录边界，也没有检查。所以升级 Mastra 或者以后换掉它，影响面是摊开的。

### P7 需要秘钥的工具没有地方放配置

现有的加密与提示机制是给模型供应商用的（`ai-model/model-secret.ts` 的 AES-256-GCM 加解密与 `hintOf`，
存在 `ai_providers.apiKeyCipher` / `apiKeyHint`）。工具如果要用 token 调外部服务，
现在只能塞进 env，既没法在后台轮换，也没有"只进不出"的保护。

### P8 技能在提示词与工具面之外

系统提示词里写着"清单外的能力你没有"，但模型手上实际有三个技能工具（`skill` / `skill_search` /
`skill_read`），由 Mastra 在 Agent 层自动挂上（`agent-*.js:36994`）。它们不进我们的注册机，
没有开关、没有限额，审计里也没有我们的结论元数据。

技能目录（name / description / location / source）由 Mastra 的 `SkillsProcessor` 注入 system message，
我们自己的 `prompts/templates/partials/` 里没有技能段，于是"技能到底注入了什么"这件事，
我们的提示词引擎看不到（详见 §5.10 的「技能：现状与三条路线」）。

技能正文是以工具结果的形式回到模型的，会被 `contextToolResultMaxRatio` 截断
（`context.service.ts:342-358`）；截断后没有接着读的通道，`skill_read` 只能读 `references/` 下的文件。

### P9 子 agent 拿不到运行时信封，工具面也没有清单

主 agent 现场为子 agent 写提示词并原样使用，工具面在装配期算好（全部 − 委派类）。但 `agent.stream()`
只传了 `maxSteps` 与 `abortSignal`，**没有把运行时信封传下去**（`agent-runner.ts:233-236`），于是：

- 网关判不了身份、作用域、限额，审计里写不出 `conversationId` 与 `triggeredBy`；
- 规划工具（`plan-*`）在子 agent 工具面里却没有信封，每次调用必然抛"缺运行时上下文，请交回主 agent"
  （`planner.core.ts:160-168`），白烧一步；
- 子 agent 的提示词里没有工具清单，"你不能再造子助手"也没人说给它听。

细节与要补的四条见 §5.10 的「子 agent：现状与要补的四条」。

## 3. 预期效果

| # | 现在 | 改后 | 怎么验收 |
| --- | --- | --- | --- |
| 1 | 每个工具自己写 `createTool`、开关与边界判断 | 工具只交一份声明（`ToolSpec`），开关、边界、审计、分页由网关插件统一做 | 三个核心工具改成声明后行为不变；边界判断在代码里只有一份 |
| 2 | 改开关或超时要改 env 再重启 | 后台页面改（列表开关、编辑抽屉、恢复默认），下一次调用生效 | 页面改开关，同一进程内再调一次工具，行为已变，服务未重启；秘钥只回提示串 |
| 3 | 拒绝、越界只有 warn 日志 | 每次调用落一条带结论的时间线记录（含拒绝原因、耗时、配置版本） | 前端工具卡片能看到"被拒：不在工作目录内"，按会话能查出来 |
| 4 | 截断即丢，模型只能重跑 | 模型拿到第一页和页柄，可用 `read-tool-result` 取下一页，库里仍是全量 | mock 模型跑一次大结果：模型收到页、能取第 2 页、时间线原文完整 |
| 5 | 模型调不存在的工具，只有英文错误 | 落一条标记过的记录、附近似工具名、计数 | 时间线上能看到该次调用被标为未知工具 |
| 6 | 27 处 Mastra import 散在 16 个文件 | 适配器目录收口，`ai/tools/**` 禁止 import `@mastra`，未收口的文件进允许清单（只减不增） | `pnpm check:mastra` 能拦住新引入的依赖 |
| 7 | 工具秘钥只能进 env | 入库加密（复用 AES-256-GCM），接口只回提示串，日志与出参自动脱敏 | 后台填一个 token，库里是密文，接口不返回明文 |
| 8 | 测一个工具要穿透 `createTool`、造 Mastra 上下文，`planner` 一类还要连库 | 直接调 `exec(input, ctx)`，依赖走构造器注入；注册机驱动的标准测试集覆盖全部工具 | 每个工具的单测不连模型与数据库；新工具漏写测试会被标准测试集兜住 |
| 9 | 技能工具在工具清单外、不可控，提示词与实际工具面对不上 | 一期：如实登记为 runtime 工具（提示词与后台清单分开列，审计标 `source: 'runtime'`），提示词措辞改准确。二期：技能进注册机，可开关、可限额、正文可分页 | 后台工具清单里技能工具与注册工具分开列且能对上账；提示词不再声称"清单外都没有" |
| 10 | 子 agent 没有信封（网关卡不住、审计缺字段）；规划工具在子 agent 里必然报错；子 agent 提示词里没有工具清单 | 信封传下去（`depth + 1`）；`ToolSpec` 增 `child: 'allow' \| 'deny'` 并把四个 `plan-*` 标 deny；`latestPlan` 只看根 run；子 agent 提示词追加固定的能力段 | 子 agent 调规划工具得到明确结论而不是抛错；子 agent 的工具调用在时间线里有会话与身份字段 |

范围外（不做）：参数 schema 入库后解释执行、自造 DSL 解析器、重写上游对未知工具的拦截、
为权限造 RBAC、人工审批（列三期）。

## 4. ROI

### 4.1 收益与依据

| 收益 | 依据（当前可核对的事实） |
| --- | --- |
| 策略只有一份实现 | 开关、边界、超时、输出上限现在由每个工具各写一遍；改后是插件里的固定顺序，新工具自动继承 |
| 运维动作从"改 env 再重启"变成"后台改" | `run-command` 的 4 个配置在 env（`ai.config.ts:55-61`）；重启的代价是一次发布流程 |
| 排障入口从日志变成时间线 | 现在只有 `command.core.ts:124`、`:130` 两条 warn，工具级拒绝无审计 |
| 大结果可回取（新增能力） | 现在只有截断，没有取回通道（`context.service.ts:342-358`） |
| 依赖变更的影响面收敛 | 27 处、16 个文件 → 1 个适配器目录加一份契约测试；`ai.model-decision.ts` 与 `agent-mastra-store.ts` 已经是这个定位 |
| 秘钥可轮换且有脱敏 | 工具现在没有秘钥存放位置，只能进 env |
| 工具测试不再依赖模型与数据库 | 现在测一个工具要从 `createTool` 产物里抠 `execute` 并手工造 `RequestContext`（`test/ai-command-core.test.ts:32-38`、`ai-plan-subagents.test.ts`）；改后直接调 `exec`，插件与网关用 fake 依赖 |

### 4.2 成本

- 一次性：第 0 期的两个前置实验，然后是四个批次（骨架、注册机与网关、配置入库、分页），见 §5.14。
  工作量取决于第 0 期结论，我还没做评估，不在这里给数字。
- 长期：每次工具调用多一层包装和一次配置读取（走进程内缓存，实际开销在实现时实测并记进文档）；
  多一个适配器目录要维护；后台多一个配置页。

### 4.3 什么时候算回本

三个判据，任何一个先出现就算回本：

1. 第一次需要"不重启就关掉某个工具"或调整它的限额；
2. 接入第一个业务工具，不用再抄一遍样板和边界判断；
3. 第一次排障"模型为什么没用成这个工具"，看时间线而不是翻日志。

第 1 条在日常运维里出现得最频繁，投入最小的第 3 批就能拿到。

### 4.4 不做的代价

- 业务工具一旦接进来（`AGENT_TOOLS` 就是为它留的），样板和边界判断会按工具数量复制，
  漏写一处就是一个安全口子；现在只有 3 个工具，问题还不明显。
- 业务查询类工具的返回天然比命令输出大，分页缺失的问题会被放大。
- Mastra 的升级改动继续散在 16 个文件里。

## 5. 具体实施方案

> **编码约定（铁律）**：本工程所有**文字性多行字符串**（工具说明、提示词片段、错误话术、落库正文）
> 一律写成 ``dedent`...` ``，禁止 `+` 拼接与 `[...].join('\n')`。
> 另：**除纯类型文件外，一个文件一个职责**（所有包都适用）—— 工具引擎因此按
> "契约 / 端口 / 纯逻辑 / 服务 / 实现 / 插件"拆成一文件一件事，插件是**一个插件一个文件**。
> 两条都已写进 `.agents/skills/billy-dev-foundation/references/code-conventions.md` 第 11 / 12 条。

### 5.1 总体结构

```
┌──────────── 主体（禁止 import @mastra）────────────────┐
│  ToolSpec（DSL）                                        │
│  ToolRegistry（注册机：注册 / 对账 / 读配置 / 发工具）  │
│  ToolGateway（网关）+ plugins（插件链）                 │
│  ToolOutcome / ToolCallContext / Toolbox                │
│  AgentEnvelope（我们的运行时信封）                      │
└──────────────────▲─────────────────────────────────────┘
                   │ 端口：只认上面这些类型
┌──────────────────┴─────────────────────────────────────┐
│  适配器 ai/mastra/**（唯一可 import @mastra 的地方）    │
│   tool.adapter / agent.adapter / context.adapter / stream.adapter │
│   （已有同定位的：storage adapter、model adapter）      │
└──────────────────▲─────────────────────────────────────┘
                   │
              Mastra / AI SDK
```

词汇对照只在适配器里做一次：

| 我们的词 | Mastra |
| --- | --- |
| `key` | `createTool({ id })` |
| `params`（zod） | `inputSchema` |
| `exec(input, ctx)` | `execute` |
| `ToolOutcome` | 返回值 / 错误结果 |
| 分页视图 | `toModelOutput` |
| `Toolbox` | `ToolsInput` |
| `ToolCallContext` | `ToolExecutionContext` |
| `AgentEnvelope` | `RequestContext` |
| `ToolChunk` | AI SDK v6 的 part 名 |

### 5.2 工具 DSL

落点 `ai/tools/tools.types.ts`（`ToolSpec` 类型）+ `ai/tools/tool.decorator.ts`（`@ToolGroup` 类级 +
方法级 `@ToolDecl`）+ `ai/tools/tool.class.ts`（`buildToolSpecs(instance)` 把"工具组实例 + 装饰器元数据"
拆成 **1..n** 个 `ToolSpec`）—— 纯类型与纯函数，禁止 import `@mastra`。

**写法（2026-10-01 起：工具组 + 方法即工具）**：一个工具组 = 一个 `@Injectable()` 类
（可选类上 `@ToolGroup({ category?, scope?, child? })` 给组内共同默认值），
**组内一个 `@ToolDecl` 方法就是一个工具**（声明 + 执行体同一处）。钩子不另设装饰器，
**按方法名写在声明里**：`precheck: 'checkWorkDir'` / `normalize: 'normalizeConfig'`。
依赖（仓储 / 执行器 / 日志）全部走构造器 `@Inject`，组内工具共享，与业务代码**同一条 IoC 链路**，
装配处不必手工 `new`。`params` / `config` 是**同一文件里的模块级 zod 常量**
（装饰器在类定义期求值，不能引用本类 static）。
`buildToolSpecs(instance)` 是**唯一的装配入口**：组内没有 `@ToolDecl` 方法、缺 `key`/`title`/`description`/
`params`/`config`、类别与作用域既没写在声明里也继承不到、组内 key 重复、钩子方法不存在 ——
一律**启动期抛错**（宁可起不来，也不要带一个"看起来在册、实际调不动"的工具跑）。
**一个类一个工具 = 组里只有一个方法**：形状只有一种，不必为"单工具"另写。

`buildToolSpecs()` 产出的内部形状仍是 `ToolSpec`（网关 / 注册机 / 后台页只认它）：

```ts
export interface ToolSpec<C = unknown, I = unknown, O = unknown> {
  readonly key: ToolKey            // 名称：稳定对外标识，取自 tool-keys.ts
  readonly title: string           // 人读标题（提示词列举用）
  readonly description: string     // 唯一一份说明：模型选工具看到的也是它
  readonly category: 'core' | 'business'
  readonly params: z.ZodType<I>    // 参数契约
  readonly result?: z.ZodType<O>   // 出参契约（可选）
  readonly config: z.ZodType<C>    // 配置契约：**每个字段都必须自带默认值**（见下）
  readonly secrets?: z.ZodType     // 秘钥字段（一律可选、没有默认值）
  readonly scope: ToolScope        // 默认作用域，可被库里覆盖
  readonly delegation?: boolean    // 委派类工具（算子 agent 工具面时排除）
  readonly child?: 'allow' | 'deny'  // 子 agent 能不能用（默认 allow；delegation 隐含 deny）
  readonly paginate?: { pageBytes: number }   // 声明会返回大结果才分页
  exec(input: I, ctx: ToolCallContext<C>): Promise<O>   // 只写业务动作
  precheck?(input: I, ctx: ToolCallContext<C>): Promise<string | null> | string | null  // 只读前置条件
  normalize?(config: C, caps: ToolEnvCaps): C           // 配置夹到部署上限（纯函数）
}
```

参数用 `zod`，不发明新语法。`exec` 里只留业务动作，开关与边界判断移到插件。

**配置必须有默认值**（硬规则）：`config` 的每个字段都用 zod 的 `.default()` 给默认值，
代码默认值直接来自 `spec.config.parse({})`，**不再单列 `defaults` 字段**（单列就会与 schema 漂移）。
`config.parse({})` 失败就说明这个工具的默认值没给全，启动即失败；标准测试集也把这条钉住（§5.9 第 2 条）。
于是"库里没有这一行""管理员点了恢复默认""新加一个工具"三种情形都有确定取值，不存在"没配就不能用"的中间态。

秘钥不能有默认值，所以单独放 `secrets`（字段一律可选、无默认）。它的默认状态是**未配置**，
工具遇到未配置要返回 `precheck-failed` 结论并写明缺哪个字段，不能崩。

什么入库、什么不入库：

| 部分 | 放哪 | 原因 |
| --- | --- | --- |
| key / 标题 / 描述 | 代码，库里可覆盖文案 | 说明要跟实现一起改，偶尔需要调措辞 |
| 参数 schema | 代码 | 入库后只剩字符串，类型检查全丢 |
| 配置 schema 与默认值 | 代码（`spec.config` 自带的 `.default()`） | 配置合法性只有声明知道；默认值与 schema 同源才不会漂移 |
| 配置值 | 数据库 | 需求本身，也是免重启的关键 |
| 秘钥 | 数据库（密文） | 只进不出，接口只回提示串（§5.5） |
| 开关 / 作用域 / 限额 / 页大小 | 数据库 | 管理员日常要改 |
| 部署上限 | env | 库被改坏也突破不了部署边界 |

与现有 `AgentTool` 的关系：字段语义保留（`key` / `title` / `description` / `delegation`），
`tool: AgentToolInstance` 换成 `params + config + exec`。`AGENT_TOOL_GROUPS` 的语义是
**工具组实例数组**（不再是"声明数组"）：注册机对每个组 `buildToolSpecs()` 拿 1..n 个声明；
`AGENT_CORES` / `asToolSpecs()` 已取消（每个工具是一个 `@ToolDecl` 方法，不再有"core bean 交出多个声明"这一层）。

### 5.3 注册机

落点 `ai/tools/tool.registry.ts`。

四件事：

1. 注册：对 `AGENT_TOOL_GROUPS` 里的每个**工具组实例**跑 `buildToolSpecs()`，建立 key→spec 表
   （一个组 1..n 个工具）。重复 key、组内没有 `@ToolDecl` 方法、缺 `key`/`title`/`description`/`params`/`config`、
   `params`/`config` 不是 zod schema —— 启动即失败；工具池为空（一个组都没有）同样启动即失败。
2. 对账入库：启动时把声明写进 `ai_tools`。`source='manual'` 的行只更新 `last_seen_at`，不覆盖人工改动；
   代码里删掉的工具保留配置行（历史 run 的时间线还引用着它），只记 `last_seen_at`。
3. 读配置：`settings(key)` 返回合并后的生效配置，进程内缓存，保存后失效。
4. 发工具：`toolbox(keys)` 与 `childToolbox()` 返回网关包装过的工具。主 agent（`ai.mastra.ts:103`）
   与子 agent（`chat.service.ts:1105` 的 `buildDelegable()`）都从这里取，没有旁路。

```ts
export interface ToolRegistry {
  describe(keys?: readonly string[]): ToolMeta[]
  get(key: string): ToolSpec
  settings(key: string): Promise<ToolSettings>
  toolbox(keys: readonly string[]): Toolbox
  childToolbox(): Toolbox                // 全部 − 委派类 − child:deny
  snapshot(): Promise<ToolSnapshot[]>    // 后台对账视图
}

export type Toolbox = ReadonlyMap<string, Tool>
```

### 5.4 网关与插件

落点 `ai/tools/tool.gateway.ts` 与 `ai/tools/plugins/*.ts`。

```ts
export interface ToolPlugin {
  readonly name: string
  pre?(ctx: ToolCallContext): Promise<ToolOutcome<never> | void>  // 返回结论 = 短路
  post?(ctx: ToolCallContext): Promise<void>                      // 只加工，不改业务事实
}
```

一次调用的顺序：

```
① 归一化：合并配置，补默认值，数值上限夹紧
② 依次跑 pre 插件，任一返回结论就短路跳到 ⑤
③ 跑 spec.exec（异常在这里兜成 internal 结论，不外抛）
④ 依次跑 post 插件
⑤ 返回 ToolOutcome
```

一期插件 9 个（设计稿是 10 个，`exists` 已去掉，见「实施记录」）：

| 阶段 | 插件 | 做什么 |
| --- | --- | --- |
| pre | `enabled` | 总开关。关掉返回"已被管理员关闭"，不抛错 |
| pre | `scope` | 作用域与子 agent 深度判定 |
| pre | `rate-limit` | 每轮次数与时间窗限流（复用 kits `RedisStore.incr`） |
| pre | `validate` | 入参归一化、补默认值、统一话术 |
| pre | `precheck` | 工具自己的只读前置条件（目录是否在边界内、目标是否存在） |
| pre | `audit-start` | 记开始时间与配置版本 |
| post | `paginate` | 大返回分页，写 `ctx.page` |
| post | `redact` | 秘钥字段在日志、时间线、出参里替换为提示串 |
| post | `audit-end` | 落时间线、日志、指标 |

两条边界口径由插件统一执行，保留 `run-command` 现在的做法：数值上限**夹紧**
（`command.core.ts:140-143`），语义边界**拒绝并说明**
（`:128-132`，不静默夹回，否则模型不知道自己在边界外）。

统一结论：

```ts
export type ToolOutcome<T> =
  | { ok: true; data: T; notices?: string[] }
  | { ok: false; reason: ToolDenyReason; message: string; hint?: string; retryable?: boolean }
```

`ToolDenyReason`：`unknown-tool` / `invalid-input` / `precheck-failed` / `disabled` / `forbidden` /
`rate-limited` / `timeout` / `aborted` / `internal`。前五类是给模型看的可纠正结论。

工具实现里不需要处理超时和取消：网关统一用 `Promise.race` 与信封里的 `abortSignal` 兜。

插件可以用 env 临时关掉（`AGENT_TOOL_PLUGINS_DISABLED=scope,rate-limit`），只用于排查，不入库，
关掉时打 warn。

#### 插件宿主选型：为什么不用 Cordis

[Cordis](https://github.com/cordiverse/cordis) 是 Koishi 作者写的 TypeScript 元框架，
DeepSeek Harness 就用它做底座（本机有源码，vendor 成 `@deepseek-ai/cordis`）。查过之后的结论是
**不引入**，但借它两条做法。

它是干什么的（事实）：

| 项 | 内容 |
| --- | --- |
| 提供什么 | `Context` + `Service` + 插件生命周期（Fiber 状态机 `PENDING → LOADING → ACTIVE → FAILED → UNLOADING → DISPOSED`）、`inject` 依赖驱动加载、`ctx.effect` 自动清理、事件 |
| 不提供什么 | 工具注册机与工具调用管道。DSH 的 `dsh-tools` 模块注释写得很清楚：`Tool registry … and pre/guard/around/post/result execution pipeline` —— 那是它自己写的代码，Cordis 只提供宿主 |
| 包形态 | `cordis@4.0.0-rc.10`（**仍是 RC**），MIT，ESM only，解包 68KB，运行时依赖只有 `cosmokit` 与 `@standard-schema/spec` |

不引入的三条理由：

1. 我们已经有 NestJS 作为唯一组合根（`forRootAsync` 取配置、`AGENT_TOOL_GROUPS`（工具组实例）汇总、
   `check:inject` 守构造器注入）。再进一个容器就是两套生命周期，工具的依赖会跨两个容器，
   现有的守卫也管不到跨容器那部分。
2. Cordis 的强项是**第三方插件生态**：运行期装载/卸载、依赖驱动的启停、隔离、热插拔。
   我们的插件是仓库内的策略单元（10 个、固定顺序、随应用发布），这些能力用不上。
3. 用 4.0 RC 的框架承载核心链路不划算；而且我们要的收益（统一闸门、可单测）用一个
   `ToolPlugin[]` 加纯 ctx 对象就能拿到，不需要框架。

借它的两条做法（不引依赖）：

1. **安全类插件只能拒绝**。DSH 的 `guard` 是单调的：任何 guard 只能给拒绝理由，不能放行另一个
   guard 已经拒绝的调用（`packages/core/tools/src/index.ts:1091-1108`）。我们的 `enabled` / `scope` /
   `rate-limit` 三个插件按这个语义写：只累积拒绝理由，后面的插件不能把前面插件的拒绝覆盖掉。
2. **阶段划分**。它的管道是 `pre-execute → guard → around → post → result`。我们的 10 个插件可以照这个
   对号入座：`exists` / `enabled` / `scope` / `rate-limit` / `validate` / `precheck` 属 pre 与 guard，
   `paginate` / `redact` / `audit-end` 属 post 与 result。

重新评估的触发条件（写在这里，省得下次再讨论一遍）：工具要支持**外部插件包**（npm 装上就能用、
可热插拔、彼此隔离）；或者配置驱动的动态工具面要做到"不改代码就能加工具"。

另外，要做分页时值得读一遍 DSH 的 `packages/spill`（大结果溢出与回取），做技能时读 `packages/skill`，
子 agent 读 `packages/subagent` —— 它们解决的问题和我们这几节是同一批。

### 5.5 配置入库

表 `ai_tools`（`database/entities/ai-tool-entity.ts`，在 `root.module.ts` 的 `entities` 里登记，
迁移用 `pnpm --filter @app/server db:generate <名字>`）：

| 列 | 类型 | 说明 |
| --- | --- | --- |
| `id` | varchar(20) | 与 `ai_models` 一致 |
| `tool_key` | varchar(64) | 唯一，软删感知的 partial unique（照 `ai-model-entity.ts:20-23`） |
| `title` / `description` | varchar(128) / text | **代码声明的镜像**（启动期全量覆盖写；页面只读） |
| `enabled` | boolean | 总开关 |
| `scope` | varchar(16) | `all` / `admin` / `user` / `agent` |
| `allowed_agents` | jsonb | `scope=agent` 时的清单 |
| `config` | jsonb | 配置值（可以只存被改过的字段），写入前过 `spec.config` 校验，不含秘钥 |
| `param_schema` | jsonb | **代码声明的镜像**：参数契约的 JSON Schema（启动期全量写入） |
| `secrets` | jsonb | `{ 字段名: 明文 }`（**明文入库**；提示串读取时派生） |
| `limits` | jsonb | 每轮次数、限流、页大小、每轮取页次数上限 |
| `source` | varchar(16) | `seed` / `manual` |
| `last_seen_at` | timestamp | 最后一次出现在代码声明里的时间 |
| 审计列 | — | 继承 `AuditEntity` |

`config` 允许稀疏存储：只存管理员改过的字段，缺的字段由 `spec.config.parse(合并后的对象)` 补默认值。
**种子写入时就把 `config.parse({})` 的完整默认值落进去**，这样后台页与接口读到的永远是一份完整配置，
"没配过"与"配成了默认值"不会看起来一样（也便于比对与回滚）。

**秘钥明文入库**（2026-10-01 决定，含模型供应商的 `ai_providers.api_key`）：`secrets` 列直接存明文，
提示串在**读取时**由 `hintOf` 派生（库里不再有提示列）。
代价如实记录：**库被读走就等于密钥泄露**（备份、只读账号、日志转储同理）；补偿只有两条 ——
接口不回明文（只回 `sk-…abcd` 这类提示串），日志与工具出参走 `redact` 插件脱敏。
秘钥没有默认值，`secrets` 里缺哪个字段就是"未配置"，由 `precheck` 给出结论。

生效值三级合并：

```
生效值 = env 硬上限 夹紧 ( 库里的值 ?? spec.config.parse({}) 的默认值 )
```

读取走进程内缓存（TTL 5 秒，保存后失效；多实例用 Redis 里的配置版本号做缓存键）。
工具面仍是装配期快照：后台关掉一个工具，提示词里仍列着它，只是调用被拒。
这与 `commandEnabled` 今天的口径一致（`command.core.ts:122-126`）。要让模型看不见需要重启，
动态工具面列二期。

配置接口（`/ai-tool/*`，挂 `AdminAuthGuard`，全部 POST 加 `@HttpCode(200)`）：
`list` / `detail` / `update`（`secrets` 省略=不改，空串=清空，更新后 `source='manual'`）/
`reset`（恢复代码默认）。新增错误码 3407 `ToolNotRegistered`、3408 `ToolConfigInvalid`。
工具调用期的拒绝不走 HTTP 错误码，它们是工具结论，落时间线。

表和服务放在 `modules/ai/tools/` 下（路由前缀仍用 `/ai-tool/*`）。
理由：配置合法性只有 `spec.config` 知道，拆成独立模块要么互相依赖成环，
要么为传 schema 发明一个 `forRootAsync` 校验器。

### 5.6 分页

判据：出参序列化字节数超过 `min(库里 pageBytes ?? spec.paginate.pageBytes, AGENT_TOOL_PAGE_BYTES)`。

给模型的那一份形如：

```json
{ "page": { "page": 1, "pageSize": 8192, "totalBytes": 42000, "totalPages": 6,
            "hasMore": true, "handle": "…" },
  "content": "<第一页原文>",
  "next": "用 read-tool-result 取下一页（handle=…, page=2）" }
```

两个入口用同一个纯函数 `paginate(serialized, pageBytes, page)`：

| 入口 | 谁组装 | 做法 |
| --- | --- | --- |
| 同一轮 | Mastra | 适配器用 `toModelOutput` 把给模型的视图换成分页结果，工具返回值仍是全量 |
| 跨轮 | 我们的 `context.service.ts` | 同一函数分页，保证模型前后看到的第 1 页一致 |

`toModelOutput` 的调用点已核实：durable `create-durable-agent-*.js:4605`，
非 durable `agent-*.js:27871`，都是单参调用，Mastra 自己在委派场景也用它（`agent-*.js:37498`）。

取页工具 `read-tool-result({ handle, page })` 在注册机里注册，走同一套网关。
句柄解析两级：

1. 同轮：进程内 `Map<runId:toolCallId, 全量>`。这一层不能省，整轮结束才把出参落库
   （`planner.core.ts:89-92` 记过这个事实）；
2. 跨轮或跨实例：按 `(conversationId, toolCallId)` 查时间线原文，需要给 `TimelineRepository`
   加一个查询方法，并加 `(conversation_id, tool_call_id)` 索引。

两道防护：句柄里的 `conversationId` 与当前会话不一致时拒绝，防读别人的结果；
`limits.maxPagesPerTurn`（默认 3）限制每轮取页次数。

确定性要求：同一 handle 加同一 page 必须返回同一内容，分页函数不能依赖时间、随机数或进程内状态顺序。
durable 恢复会重放工具调用，页不一致会让上下文自相矛盾。

条目级分页（按数组元素切页）列二期，只给显式声明数据路径的列表型工具。

### 5.7 权限

两层，都要保留：

| 层 | 在哪 | 管什么 |
| --- | --- | --- |
| 授权 | agent 声明 `tools: [TOOL_KEYS.x]`（`assistant.agent.ts:25`） | 这个 agent 有没有这个工具 |
| 作用域 | `ai_tools.scope` / `allowed_agents` / `enabled` | 这一次调用允不允许 |

可用 = 授权 ∩ 作用域。作用域判定需要运行时信封里有 `agentKey`，现在没有
（`ai.core.types.ts:64-90`），要补一个字段，装配处只有 `chat.service.ts` 的 `buildRuntimeContext` 一处。

| scope | 判据 |
| --- | --- |
| `all` | 任何调用者 |
| `admin` | 触发身份是管理员 |
| `user` | 触发身份是前台用户 |
| `agent` | `agentKey` 在 `allowed_agents` 里；子 agent（`depth > 0`）沿用父的判定 |

边界是权限的一部分，由插件执行：目录边界、每轮次数与时间窗限流、单次时长、输出上限。

不做 RBAC：工程只有 `UserAuthGuard` / `AdminAuthGuard` 两套身份，造角色权限体系的代价跟这件事不匹配。
审批（Mastra 的 `requireApproval` 加 suspend/resume）列三期，一期继续靠提示词纪律
（"有副作用的操作先问用户"），现状就是这样。

### 5.8 适配器

落点 `ai/mastra/**`。

| 适配器 | 现在散在哪 | 收口后做什么 |
| --- | --- | --- |
| `tool.adapter` | 三个 core bean 各自 `createTool`、`tool.builder.ts:100-106` | 我们的工具转成 Mastra 工具，含 `toModelOutput` 出页与错误结果映射 |
| `agent.adapter` | `ai.mastra.ts:79-112`、`agent-runner.ts:217-231` | 两处 `new Agent(...)` 合一 |
| `context.adapter` | `ai.mastra.ts:97-102`、工具内 `readAgentRuntime` | 信封与 `RequestContext` 的读写 |
| `stream.adapter` | `chat.service.ts:14`、`agent-runner.ts:2`、recorder 认的 part 名 | `toAISdkStream` 只在这里调，对外只给我们的 chunk |
| `skill.adapter` | `skill.loader.ts:2`、`skills.types.ts:1` | 二批收口 |

信封改动：`childTools: ToolsInput` → `toolbox: Toolbox`，
`childSkills: readonly InlineSkill[]` → `skills: readonly SkillRef[]`，新增 `agentKey`。

适配器要背的 Mastra 行为，写成 `ai/mastra/contracts.test.ts`：

| # | 假设 | 它保护什么 |
| --- | --- | --- |
| 1 | 工具面在 `new Agent()` 时一次求值 | "只能拦不能藏"这个前提 |
| 2 | durable 直接调 `tool.execute`，但 agent 级 `beforeToolCall` 仍生效且能短路（实测） | 网关包 `execute` 是**主动选择**（框架无关），不是被迫 |
| 3 | durable 以 `toModelOutput(result)` 单参调用，模型侧确实收到映射结果 | 分页的落点 |
| 4 | 未知工具与非法入参落成工具错误结果，整轮不失败 | P5 的处理方式 |

升级 Mastra 的流程：先跑这组契约测试，再看适配器要改什么。主体不受影响。

降级路径：如果第 0 期实验发现 durable 下 `toModelOutput` 不生效，
`tool.adapter` 改成"包装 `exec` 返回页，再追加一条 `tool-output-full` 时间线事件存全文"，
分页函数、页头、取页工具、配置全部复用，主体代码不动。

### 5.9 可单测性（含内建工具）

要求：每个工具、每个插件都能**脱离模型、数据库、Redis** 单独跑测试。

改造前的做法（`test/ai-command-core.test.ts`）是先从 `createTool` 的产物里把 `execute` 抠出来，
再手工造上下文；`planner` 与 `subagent` 的测试还要 import `@mastra/core/request-context` 造
`RequestContext`，再接测试库（`ai-plan-subagents.test.ts`）。类型断言把入参校验绕过去了，
Mastra 一改 execute 的形态，所有工具测试一起红。

**现在的做法（工具组 + 方法即工具 DSL，§5.2）**：`buildToolSpecs(new XxxTools(...fake 依赖...))` 拿
`ToolSpec[]`（单工具测试按 key 取那一个），直接调 `spec.exec(input, ctx)`；依赖从构造器传 fake，
`ctx` 用 `makeToolContext()` 造 —— 全程不碰 `createTool` 产物，也不 import `@mastra`。

结构约定（对工具作者的要求）：

| 约定 | 为什么 |
| --- | --- |
| `exec(input, ctx)` 可直接调用，不经过 `createTool` 的产物 | 测试里不再有类型断言，调用签名由我们的类型保证 |
| `ctx` 是普通对象：`settings` / `caller` / `log` / `signal` | 用 helper 造，不 import `@mastra`，不连库 |
| 依赖全部走构造器注入（service、runner、logger、时钟、限流计数器） | 测试传 fake；`exec` 内部禁止 `new`，禁止直接读 `process.env` |
| `exec` 内禁止 `Date.now()` 与 `Math.random()` | 分页要求确定性（§5.6）；时间与随机从 ctx 注入，测试里可固定 |
| 配置是纯数据，合并是纯函数 | `mergeSettings(defaults, row, envCaps)` 脱离数据库单测 |
| 工具不直接访问外部世界（HTTP、DB、文件） | 那些是注入依赖的事；机制类测试留在 kits 层，`test/ai-command-core.test.ts:9-13` 已经是这个分工 |

标准测试集（注册机驱动）：对注册机里的**每一个**工具跑同一组断言，新工具漏写测试会红。

1. key 在 `TOOL_KEYS` 里，`title` 与 `description` 非空，`category` 合法；
2. `params`、`config`、`secrets` 都是 zod schema；**`config.parse({})` 必须成功**（这就是"所有配置都有默认值"的机械保证），且 `secrets` 里不允许出现 default；
3. 入参契约：最小合法入参通过，缺必填被拒，超长或越界被拒；
4. `exec` 用全 fake 依赖的 ctx 能跑完；声明了 `result` 的工具，出参要能过校验；
5. 出参可序列化（分页依赖 `JSON.stringify`：没有循环引用、`BigInt`、函数）；
6. 确定性：同一入参加同一 settings 跑两次，结果一致（确实依赖外部世界的用例在测试里显式豁免）；
7. 网关行为不在工具测试里重复：`enabled=false` 时 `exec` 不被调用、超时兜成 `timeout`、
   异常兜成 `internal`，由网关自己的测试覆盖。

再加一条机械检查：`registry.battery.test.ts` 里断言每个注册工具的 key 都有对应的
`test/ai-tools/<key>.test.ts`（检查文件是否存在），缺文件即失败。标准测试集保证"能测"，
这条保证"确实写了"。

要造的测试设施：

| 落点 | 作用 |
| --- | --- |
| `test/helpers/tool-kit.ts` | `makeToolContext()`（信封、settings、静默 logger、可控时钟）、`runToolSpec(spec, input, overrides)`、标准测试集 `describeToolSpec(spec)` |
| `test/ai-tools/<key>.test.ts` | 每个工具自己的业务断言（策略与边界），用上面的 helper |
| `test/ai-tools/registry.battery.test.ts` | 枚举注册机全部工具，跑标准测试集 |
| `test/ai-plugins/*.test.ts` | 每个插件一个文件，用 fake ctx 直接调 `pre` / `post` |
| `test/ai-gateway.test.ts` | 插件顺序、短路、异常兜底、超时，全部用 fake 插件 |
| `test/ai-tool-config.test.ts` | 三级合并纯函数、种子对账幂等 |
| `test/ai-mastra/contracts.test.ts` | §5.8 的四条适配器契约 |

为了让这些测试不需要 DB 与 Redis，依赖注入的落点也一起定下来：网关注入读配置的端口
（`ToolSettingsProvider`）与日志；限流插件注入一个计数器端口（生产实现是 kits 的 `RedisStore`，
测试实现是内存 Map）。生产装配在 `ai.module.ts`，测试装配在 helper 里。

#### core 工具与技能怎么落

判断标准是"它是不是模型可调用的能力"。是，就进注册机、走网关、按标准测试集测；不是，
就走它自己的测试，不硬塞进工具框架。

| 对象 | 是不是工具 | 难点 | 落法 |
| --- | --- | --- | --- |
| `run-sub-agent` | 是（工具组 `RunSubAgentTool`，组内一个方法） | `exec` 要跑一个完整 agent：模型调用、建子 run、落时间线、转发流 | 把执行体放到端口 `SubAgentExecutor` 后面：生产实现是 `AgentRunner`，测试实现返回固定结论。spec 只留入参契约与 `precheck`（深度是纯判断；配额要查库，走 bean 注入的只读端口）。`AgentRunner` 现在自己 `new Agent`（`agent-runner.ts:217`），改成注入 agent 工厂（适配器提供）。深度、幂等复用、配额三条守卫用 fake 仓储单测；端到端保留一条（mock 模型）证接线正确 |
| 规划工具组（`core/beans/planner/planner.tools.ts`，组内四个 `@ToolDecl` 方法） | 是（工具组，一个方法一个工具） | 跨轮状态（per-run 内存、串行队列）、读时间线取当前计划 | 它们自己不写库（输出是纯数据），所以最好测：直接调 `exec` 加 fake 仓储。已覆盖：首建 / 追加 / id 重复 / 总量上限 / 缺信封（create），order 少·多·重复 / 未知 id / 标 in_progress（reorder），批量 + 幂等 + note（complete），批量删 / 删空（delete）；另有一条同轮串行读改写的端到端 |
| `run-command` | 是（工具组 `RunCommandTool`，组内一个方法） | 真执行外部命令 | 机制（`CommandRunner`）在 kits，那边已有独立单测，AI 侧只测策略（`ai-command-core.test.ts:9-13` 就是这个分工）。策略上移到插件后，工具单测变成入参契约与出参形状，插件单测管开关、边界、夹紧。现有那条"真跑 30 秒命令再比 `Date.now()`"（`ai-command-core.test.ts:87-101`）改成注入可控时钟加 fake runner，断言传下去的 `timeoutMs` |
| `SkillLoader` | **不是工具** | 启动期读盘、校验、缓存 | 它已经为测试留了可注入目录（`skill.loader.ts:19-22`、`:48-53`）。目前没有针对它的单测，只在 e2e 里用真实目录 new 出来；补：临时目录注入、缺 `SKILL.md` 报错、校验失败报错、未知技能名报错、`references/` 读取 |
| Mastra 的技能工具（`skill` / `skill_search` / `skill_read`）与技能目录注入 | 是工具，但不在注册机里 | 见下面「技能：现状与三条路线」 | 同上 |
| storage adapter、model resolution | 不是工具 | — | 各自的单测（适配器契约、纯函数），不进工具标准测试集 |

### 5.10 技能与子 agent 的能力面

这一节记现状与缺口：技能与子 agent 的能力面对不对得上账、由谁控制。

#### 技能：现状与三条路线

现状（已核实到源码）：

1. **目录会注入 system message，注入的是元数据，不是正文**。Agent 配了 skills 就自动挂 `SkillsProcessor`
   （`agent-*.js:35326-35340`；我们在 `ai.mastra.ts:105` 配了），它把技能渲染成一段 XML 注入
   （`formatSkillsCatalog`，`agent-*.js:16813-16820`）：

   ```xml
   <available_skills>
     <skill><name>…</name><description>…</description><location>…</location><source>…</source></skill>
   </available_skills>
   ```

   按名字排序（避免打掉前缀缓存）。技能正文（`instructions`）与 `references/` 的内容都不在里面。

2. **加载技能的工具已经有三个，也是 Mastra 给的**（`listSkillTools`，`agent-*.js:36994`；
   工具定义在 `workspace-*.js:6044` 起），挂在 Agent 层，随轮持久：

   | 工具 | 做什么 | 入参 |
   | --- | --- | --- |
   | `skill` | 激活技能，返回完整 instructions 加 References / Scripts / Assets 清单 | `{ name }` |
   | `skill_search` | 技能内容全文检索 | `{ query, skillNames?, topK? }` |
   | `skill_read` | 读技能目录下的文件（相对技能根的路径，支持行区间） | `{ skillName, path, startLine?, endLine? }` |

3. 我们自己的提示词模板里**没有技能段**：`prompts/templates/partials/` 下没有 skill 相关内容，
   《工具》段只渲染 `ToolRegistry.describe`。于是现在有一处不一致：提示词写着"清单外的能力你没有"，
   而模型手上确实有三个清单外的工具（`skill` / `skill_search` / `skill_read`）。

4. 技能正文是**工具结果**回到模型的，于是会走 `contextToolResultMaxRatio` 的截断
   （`context.service.ts:342-358`）。长技能被截断后没有接着读的通道（`skill_read` 只能读
   `references/` 下的文件，读不到被截断的 instructions 后半段）。

三条路线：

| 路线 | 做法 | 代价 |
| --- | --- | --- |
| A 只登记边界（一期按此写） | 把三个技能工具列为 runtime 工具：提示词《工具》段单列一组、后台工具清单单列一组、审计标 `source: 'runtime'`。实现不动 | 开关与限额管不到；目录注入仍由 Mastra 决定，我们的提示词引擎看不到技能 |
| B 收进注册机（建议二期） | 不把 `skills` 交给 Mastra，自己在注册机加 `skill-activate` 与 `skill-read`（数据来自 `SkillLoader`），目录段由我们的模板渲染（`partials/skills.eta`，格式沿用 `<available_skills>`）。于是技能有开关、走网关、正文可分页、激活与读文件都有审计 | 要自己实现"激活后如何呈现"与目录渲染，并给它们写测试；Mastra 那套 TTL 与线程级状态不跟过来（我们也不需要） |
| C 只换工具、保留 Mastra 的目录注入 | 保留 `skills`（目录注入不变），把自带工具换成注册机版本 | 需要确认能否单独关掉自带工具：`suppressEagerSkillTools` 只在配了 on-demand processor 时为真，且它只跳过 `skill` 与 `skill_search`，`skill_read` 仍会挂上（`agent-*.js:38504`、`:37015`）。要动手得先做验证，不建议一上来选它 |

路线 B 的可行性依据：`AgentConfig` 有 `skills` / `skillsFormat`，也有 `inputProcessors`
（`agent/types.d.ts:825-889`），所以"不交 `skills`、自己渲染目录"是能做的；激活语义本身不复杂
（Mastra 的激活就是把 instructions 加 References 清单拼成一段返回，`workspace-*.js:6053-6060`）。

#### 子 agent：现状与要补的四条

现状（已核实到源码）：

| 项 | 现状 | 依据 |
| --- | --- | --- |
| 提示词 | 主 agent 现场写，原样使用；不加我们的模板，不注入运行环境，《工具》清单段也没有 | `agent-runner.ts:222`；运行环境只给根 agent（`ai-agent.md` §3.15.4） |
| 工具面 | 编排层在装配期算好放进信封：全部 − 委派类 | `chat.service.ts:1105` 的 `buildDelegable()` → `agent-runner.ts:229` |
| 技能面 | 继承父 agent 的（所以技能目录与三个技能工具在子 agent 上同样存在） | `chat.service.ts:1106` → `agent-runner.ts:230` |
| 运行时信封 | **没有传下去**：`agent.stream()` 只给 `maxSteps` 与 `abortSignal` | `agent-runner.ts:233-236` |
| durable | 临时 Agent 未开 durable，崩溃恢复不覆盖子 agent 的步；重放靠 `(parent_run_id, tool_call_id)` 复用已成功的子 run | `agent-runner.ts:217-231`、`:124-150` |
| 落库 | 子 run 独立成行（`parent_run_id` / `depth` / `tool_call_id`），提示词与任务全量落 `runs.request_snapshot`，明细走同一个录制器，实时明细写进父流 | `agent-runner.ts:165-195` |
| 旋钮 | 每轮个数、深度、步数、超时都在 env | `ai.config.ts:39-46` |

四个缺口：

1. **没有信封，网关判不了**。网关要判身份、作用域、限额，审计还要写 `conversationId` 与 `triggeredBy`；
   子 agent 那一轮 `readAgentRuntime()` 拿到的是 null。
2. **规划工具（`plan-*`）在子 agent 的工具面里，但它们必然报错**。它们没被标 `delegation`，所以进了子 agent 工具面；
   没有信封时 `planner.store.ts` 会抛"缺运行时上下文，请交回主 agent"。对模型来说这是一次白烧的调用。
3. **把信封传下去会踩到第二个坑**：`latestPlan(conversationId)` 不带 run 过滤
   （`timeline.repository.ts:100-107`），子 agent 提交的清单会顶掉父的"当前计划"。
   今天它不发作，只是因为缺口 2 让子 agent 根本提交不了。
4. **子 agent 的提示词里没有工具清单**。父 agent 的《工具》段列出 key 与说明，子 agent 只有
   function calling 的 schema；"你不能再造子助手"这句话也没人说给它听。

要补的四条：

| # | 动作 | 理由 |
| --- | --- | --- |
| 1 | 信封传下去：`AgentRunner` 造临时 Agent 时注入 `RequestContext`，`depth = 父 + 1`，`agentKey = sub:<name>`，其余字段继承父 | 网关与审计的前提 |
| 2 | `ToolSpec` 增 `child: 'allow' \| 'deny'`（`delegation: true` 隐含 deny），四个 `plan-*` 标 deny；`childToolbox()` = 全部 − 委派类 − deny | 缺口 2 的正面修法，把"哪些工具子 agent 不该有"变成声明 |
| 3 | `latestPlan` 加"只看根 run"（`NOT EXISTS` 子查询，与 `context.service.ts` 的 `rootOnly` 同一手法） | 缺口 3 |
| 4 | 子 agent 的提示词由我们追加一段固定尾巴：工具清单（key + 标题）、一句"没有委派类工具"、交付要求；主 agent 写的那份保持不变放前面 | 缺口 4，做法见待拍板第 7 条（§5.10） |

`run-sub-agent` 的四个旋钮（每轮个数、深度、步数、超时）按同一套做法迁进 `ai_tools.config`，
和 `run-command` 同批。

### 5.11 后台页面（工具配置）

路由 `/main/ai/tools`，菜单加在 `apps/admin/src/components/AppMenu.tsx` 的 AI 分组里，写法照
`ai/models/page.tsx`（`@repo/ui` 的 `DataTable` / `ModalForm` / `Switch` / `DictSelect` / `ConfirmAction`
加 TanStack Query / Form）。页面要解决的事只有一件：**不重启就能改工具的开关、作用域、限额、配置与秘钥**。

列表（`DataTable`）：

| 列 | 说明 |
| --- | --- |
| 工具 key | 等宽字体 + 复制按钮（`copy` 与 `tool-keys.ts` 里的常量对得上账） |
| 标题 | 覆盖过的标题加一个标记（`source='manual'`），点开能看到代码里声明的原文 |
| 类别 | `core` / `business` / `runtime`（runtime 是 Mastra 自带，只读，见 §5.10） |
| 开关 | 行内 `Switch`，改完立刻生效（不走弹窗确认，误改可再点回来） |
| 作用域 | `DictTag` 展示 `all` / `admin` / `user` / `agent(清单长度)` |
| 限额摘要 | 每轮次数、限流、页大小三个值，只读展示 |
| 来源 | `seed` / `manual` |
| 更新时间 | 加 `updated_by`（`AuditEntity` 自带） |
| 操作 | 编辑 / 恢复默认 / 查看运行记录（跳到该工具的时间线筛选） |

筛选：关键字（key 与标题）、类别、开关、来源。分页与排序交给 `DataTable`。

编辑抽屉（`ModalForm`）：

- **只读区**：key、类别、参数 JSON Schema（折叠）、**哪些 agent 授权了它**（服务端从注册机算，
  因为授权写在 agent 声明里，DB 没有这份数据）、秘钥提示串（`sk-…abcd`）。
- **可改区**：开关、作用域（`DictSelect`）、`allowed_agents`（只在校验 `scope=agent` 时出现）、
  限额、工具专属配置。
- **工具专属配置的渲染**：一期按工具手写面板（`run-command` 的面板就是超时、输出上限、工作目录三个字段），
  每个字段旁边显示默认值，并给一个"用默认值"的入口。二期工具多了再上通用渲染器：zod → JSON Schema → 表单；
  通用渲染器要处理联合类型、数组、条件字段，边界成本高，工具少的时候不划算（待拍板第 8 条）。
- **秘钥**：只显示提示串。留空=不改，给空串=清空，填新值=覆盖；表单不做回显，也不进前端状态之外的任何日志。
- **底部**：保存（`update`）、恢复默认（`reset`，`ConfirmAction` 二次确认，写明"会清掉覆盖值，回到代码默认"）。

几个如实写进页面的提示，避免误解：

1. 改完**不需要重启**，下一次工具调用生效；
2. 但**工具面是装配期快照**：关掉一个工具后，模型的提示词里仍然列着它，只是调用会被拒（§5.5）；
3. runtime 工具（技能那三个）不受开关与限额控制，单独一组只读展示（§5.10 路线 A）。

保存后的反馈：`toastSuccess` 加一句"下一次调用生效"；失败一律 `toastError` 带错误码
（3407 未注册的工具 / 3408 配置值不合法 / 3405 秘钥加密口令不可用）。

### 5.12 边界守卫

仿 `scripts/check-inject-decorators.ts`（`pnpm check:inject`）新增
`scripts/check-mastra-boundary.ts` → `pnpm check:mastra`：

- `ai/tools/**` 出现 `@mastra`：失败；
- `ai/mastra/**`：允许；
- 其余 14 个 AI 文件进允许清单并记录 import 条数，只减不增。

允许清单写在脚本里，新增依赖必须显式改脚本，改动留痕。

### 5.13 改动面

| 动作 | 对象 |
| --- | --- |
| 新增（主体） | `tools/tool.spec.ts`、`tool.registry.ts`、`tool.gateway.ts`、`plugins/*.plugin.ts`（9 个，一个插件一个文件）、`tool.config.service.ts`、`tool-result.store.ts`、`read-tool-result.ts`、`paginate.ts`、`tool.seed.service.ts`、`tool.ports.ts`（配置读取、限流计数器、子 agent 执行器三个端口） |
| 新增（适配器） | `mastra/tool.adapter.ts`、`agent.adapter.ts`、`context.adapter.ts`、`stream.adapter.ts`、`contracts.test.ts` |
| 新增（其他） | `ai-tool-entity.ts` 加迁移；`ai-tool.controller.ts`；shared 的 schema、字典、错误码 3407 与 3408；SDK `aiTool`；后台 `ai/tools/page.tsx` 加菜单；`scripts/check-mastra-boundary.ts` |
| 新增（测试） | `test/helpers/tool-kit.ts`；`test/ai-tools/<key>.test.ts` 与 `registry.battery.test.ts`；`test/ai-plugins/*.test.ts`；`test/ai-gateway.test.ts`；`test/ai-tool-config.test.ts`；`test/ai-mastra/contracts.test.ts` |
| 改动 | `tools.types.ts`、`tool.builder.ts`、三个 core bean、`ai.core.types.ts`、`ai.mastra.ts`、`agent-runner.ts`（信封传下去、`new Agent` 改走适配器）、`chat.service.ts`、`context.service.ts`、`stream-recorder.ts`、`timeline.repository.ts`（`latestPlan` 只看根 run）、`ai.module.ts`、`app-config.ts`、`root.module.ts`、`package.json` |
| 不动 | Mastra 装配与 durable 机制、`runs` / `timelines` 写入口径、`tool-keys.ts`、提示词模板、子 agent 工具面的"排除法"（仍是排除，只是多一个 `child: deny` 轴） |

### 5.14 实施顺序

| 批次 | 内容 | 结束标志 |
| --- | --- | --- |
| 0 | 两个实验：durable 下 `toModelOutput` 是否生效（流里是全量、模型收到页）；恢复重放时句柄 Map 是否自洽 | 结论落进 §5.8 的降级选择 |
| 1 | 适配器四个加契约测试加 `check:mastra`；`ToolSpec` / `Toolbox` / `ToolOutcome` 类型；信封去掉 Mastra 词汇并加 `agentKey`；子 agent 也注入信封（`depth + 1`）；`latestPlan` 只看根 run；`test/helpers/tool-kit.ts` 与标准测试集 | 守卫绿，现有测试不回归，标准测试集能跑通一个示例工具 |
| 2 | 注册机、网关、9 个插件；core bean 改交声明，行为保持等价；规划工具标 `child: deny`（子 agent 工具面 = 全部 − 委派类 − deny）；插件与网关的测试文件、每个工具的测试文件 | 工具行为与现在一致，边界判断只有一份；标准测试集覆盖注册机里全部工具 |
| 3 | `ai_tools` 加迁移加种子加配置服务加 `/ai-tool/*` 加 SDK 加后台页；`run-command` 的 4 个旋钮迁入库；配置合并与种子对账的测试 | 后台改开关或超时，下一次调用生效，服务未重启；种子跑两次幂等 |
| 4 | 分页纯函数、`paginate` 插件、`toModelOutput`、跨轮入口、`read-tool-result`、句柄两级解析、越权与滥用防护；分页边界与确定性的测试 | 大结果模型只收一页并能取下一页，库里仍是全量 |
| 二期 | 条目级分页；配额细化；动态工具面；技能收进注册机（路线 B：`skill-activate` 与 `skill-read` 加自己渲染目录段）；`skill.adapter` 收口；允许清单继续收敛 | — |
| 三期 | 人工审批（suspend/resume 加前端批准框加恢复链路） | — |

第 2 批刻意保持行为等价，只搬家不改语义，把重构和新能力分成两次提交，出问题好定位。

### 5.15 验收

实验（不通过就要改方案）：

1. durable 下 `tool-output-available` 带的是全量出参，模型侧收到的是映射后的页，非 durable 行为一致；
2. durable 恢复重放后，取页内容与首次一致。

测试：

| 层 | 用例 |
| --- | --- |
| 主体单测 | 9 个插件的正反例；三级配置合并；夹紧与拒绝两条口径；`paginate` 的边界（刚好一页、多页、空、多字节字符不切半）；作用域矩阵；句柄跨会话拒绝；取页次数超限 |
| 工具单测 | 每个工具一个文件测自己的策略与边界；`registry.battery.test.ts` 对注册机里全部工具跑标准测试集（§5.9 的 7 条），漏写即红 |
| 子 agent | 子 agent 的工具调用在时间线里有会话与身份字段；规划工具在子 agent 里得到明确结论而不是抛错；深度、配额、幂等复用三条守卫用 fake 仓储测 |
| 无依赖 | 工具、插件、网关、配置合并的单测不连模型、数据库、Redis（用 helper 里的 fake 依赖与内存计数器） |
| 适配器单测 | §5.8 的四条契约；结论到返回值与错误结果的映射 |
| 集成 | 改库后下一次调用生效；被禁工具落 `tool-result(isError)` 且整轮不失败；大结果取第 2 页且时间线完整；种子对账幂等 |
| 迁移 | 建表；partial unique 条件；`(conversation_id, tool_call_id)` 索引 |
| 守卫 | `ai/tools/**` 引入 `@mastra` 必须失败 |
| 回归 | `pnpm typecheck && pnpm test && pnpm check:ui && pnpm check:inject && pnpm check:mastra`；离线 mock 模型加一条"大结果分页到取页"的端到端断言 |

### 5.16 风险

| 风险 | 应对 |
| --- | --- |
| 每次调用多一层包装和一次配置读取 | 配置走进程内缓存，实际开销实现时实测并记进文档 |
| 配置入库后"为什么这个工具能用"多了一个变动源 | 时间线落配置版本号，审计列有 `updated_by`，后台页显示 `source` |
| 分页与 durable 重放的确定性 | §5.6 的硬要求加单测（同句柄同页两次取到的字节一致） |
| 前端不认识新的 state 与结论元数据 | 与文档同批改工具卡片渲染，列入第 4 批的结束标志 |
| 适配器多一层间接 | 收益是升级影响面收敛和降级只改一处，用契约测试守住 |
| 一期不能动态改工具面 | 后台页写明"关闭后模型仍可见，调用时被拒" |
| 秘钥进工具配置扩大敏感面 | 复用现有加密与提示串口径，`redact` 插件兜日志与出参，接口只回提示串 |
| 工具作者绕过可单测的约定（`exec` 里读 env、用 `Date.now()`、直接 `new` 依赖） | 标准测试集用 fake 依赖与确定性断言把这类写法暴露出来；约定清单进 `develop-ai-agent` skill |

## 6. 待拍板

1. 插件清单：§5.4 的 10 个是否合适，`validate` 与 `precheck` 可以合成 1 个。
2. 秘钥归属：放 `ai_tools.secrets_cipher`（每工具一份，本稿按此写），还是建一张统一凭据表（多工具共用、便于轮换）。
3. 配置模块归位：本稿建议表与服务放 `modules/ai/tools/`、路由用 `/ai-tool/*`；若坚持独立 `modules/ai-tool`，需要补一个 schema 传递机制。
4. 作用域：一期做四档，还是先做 `all` / `admin`。
5. `read-tool-result`：作为内建工具常驻在工具清单里（本稿按此写），还是只在被分页时通过提示词临时告知。
6. 技能路线：一期走 A（只登记边界），还是直接做 B（技能进注册机）。B 一旦做了，技能就能开关、能限额、正文能分页，代价见 §5.10 的「技能：现状与三条路线」。C 需要先验证，不建议。
7. 子 agent 的提示词：由我们追加一段固定的能力段（工具清单 key + 标题、"没有委派类工具"、交付要求，一致且可测），还是维持现状（完全由主 agent 写，只靠 function calling 的 schema 让模型知道有什么工具）。
8. 配置表单：一期按工具手写配置面板（工具只有 3 个，可控），还是直接上"zod → JSON Schema → 表单"的通用渲染器（工具变多才划算，见 §5.11）。

## 附：术语

| 词 | 含义 |
| --- | --- |
| 工具 DSL | `ToolSpec`：一个工具的声明 |
| 注册机 | `ToolRegistry`：工具的唯一来源 |
| 网关 | `ToolGateway`：所有工具调用的必经之路 |
| 插件 | `ToolPlugin`：一个处理单元，pre 阶段可短路 |
| 适配器 | `ai/mastra/**`：我们与 Mastra 之间的唯一接口 |
| 主体 | `ai/tools/**`：不出现 Mastra 词汇的部分 |
| 生效配置 | `env 硬上限 夹紧 (库里的值 ?? 代码默认值)` |
| 页柄 | 分页结果的取回凭据，同轮查进程内，跨轮查时间线 |
| 契约测试 | 固定"我们依赖的 Mastra 行为"的测试，升级时先跑它 |

## 实施记录（一期，2026-10-01）

批次 0–4 已落地，`pnpm typecheck` / `test` / `check:ui` / `check:inject` / `check:mastra` 全绿。
下面是**与设计稿不一致的地方**（都为了实事求是，逐条给理由）：

| # | 设计稿 | 实施 | 理由 |
| --- | --- | --- | --- |
| 1 | 契约 ②「durable 不跑 agent 级工具钩子」 | **实测是跑的**，且 `{proceed:false, output}` 能短路 | 最早的结论来自对 dist 的 grep（durable 文件命中 0 次），但钩子是在 **Agent 层**包装工具实例的 —— 以实测为准，`test/ai-mastra-contract.test.ts` 把它钉住。我们**仍**包 `execute`，因为那样网关不必认识 Mastra 的钩子 API（主体框架无关），不是被迫 |
| 2 | pre 插件 10 个（含 `exists`） | **9 个**（去掉 `exists`） | 它要注入注册机，而注册机 → 网关 → 插件 → 注册机**成环**；且网关只会包注册机里的声明，这个分支运行期到不了。"模型编了个不存在的工具"在更靠前的地方就被上游落成工具错误结果，由**录制器**标成 `unknown-tool` state（可查、可计数）才算数 |
| 3 | 分页「按字节切」 | 按**码点边界**切（每页仍受字节预算约束） | 按固定字节偏移硬切会让页边界压进半个汉字里，页与页之间**既重复又漏字**（单测逮住过）。现在逐字符累加，保证所有页拼起来逐字节等于原文 |
| 4 | 表结构里没有"类别"列 | 加 `ai_tools.category`（冗余列，种子从声明写过来） | 后台页要按类别筛选；类别只在代码声明里，不落列就只能"先分页再过滤"（分页就假了） |
| 5 | 待拍板 7：子 agent 提示词是否追加能力段 | **追加**（`withCapabilityTail`） | 子 agent 的提示词由主 agent 现写，它看不到我们的《工具》模板段，于是不知道自己有什么工具、也不知道"不能再造子助手"；追加不覆盖主 agent 的原话 |
| 6 | 技能路线 A/B/C 待拍板 | **一期走 A**：三个技能工具登记为 runtime 工具（后台只读一组 + 提示词措辞改准） | B 要重做技能激活与目录渲染，收益（开关 / 分页）与代价不匹配；与"动态工具面"一起放二期 |
| 7 | 内存限流实现"测试实现放 helper" | 落实：`src/` 只留接口与 token，Redis 版一个文件、测试用的内存版在 `test/helpers/` | 单一职责铁律：`src/` 不该出现第二套计数实现 |
| 8 | 遥测指标（Telemetry 计数 / P95） | 一期只做**结构化日志 + 时间线**；指标列二期 | 先把审计证据落全（日志字段已经带耗时 / 字节数 / 页数 / 拒绝原因），指标是消费侧的事 |
| 9 | 工具标准的"契约测试"文件路径 `test/ai-mastra/contracts.test.ts` | 落在 `test/ai-mastra-contract.test.ts` | 与 `apps/server/test/` 既有的扁平命名一致（该目录无子目录惯例） |

实施中新增的两条工程铁律（已写进 `billy-dev-foundation/references/code-conventions.md`）：

- 第 11 条：文字性多行字符串一律 ``dedent`...` ``，禁止 `+` 拼接与 `[...].join('\n')`；
- 第 12 条：除纯类型文件外**一个文件一个职责**（所有包）—— 工具引擎因此拆成
  "契约 / 端口 / 纯逻辑 / 服务 / 实现 / 一个插件一个文件"。

### 追加决定（同日，用户口径）

| # | 决定 | 落点 |
| --- | --- | --- |
| 10 | **配置整列替换**：`config` / `limits` 是 jsonb **整列**写，不按 key 合并 | 前端在配置有改动时提交**整份生效配置**（这样"把某项改回默认值"才表达得出来）；后端语义不变 |
| 11 | **秘钥明文存储**（含 `ai_providers.api_key`） | 删掉 AES-GCM 加解密（`model-secret.ts` → 只剩 `hintOf` 的 `secret-hint.ts`）；迁移把老密文**就地解密回填**（解不开留 NULL 并告警）；配置项 `AI_MODEL_ENCRYPTION_KEY` 随之删除 |
| 12 | **前端只配配置，基础信息留在代码** | `title` / `description` / `category` / `param_schema` 由启动期种子**全量覆盖**写入（代码是唯一事实源）；`AiToolUpdateSchema` 去掉 `title` / `description`；后台页删掉"已改文案"标记 |
| 13 | **启动全量写 DSL** | `ToolSeedService` → `upsertSeed`：基础信息每次启动覆盖写；`enabled` / `scope` / `allowed_agents` / `limits` / `config` / `secrets` **不动**（人的决定），只在新建时给默认值 |

二期待办（与设计稿一致的部分）：条目级分页、配额与限流细化、动态工具面、
技能收进注册机（路线 B）、`skill.adapter` 之外的允许清单继续收敛、遥测指标、
以及 `runtime/chat.service.ts`（既有 1265 行）的职责拆分。

## §3.16 规划能力：一组四个工具（2026-10-01 定，取代单工具 `todo-write`）

**结论**：planner 是 agent 用的**规划工具集**，不是"一个全量覆盖的写清单工具"。

| 工具 key | 入参 | 语义 |
| --- | --- | --- |
| `plan-create` | `{ goal?, tasks: [{ id?, title, status?, note? }] }`（1..30 条） | 没有清单时创建（**必须给 `goal`**）；**已有清单时是追加**（`goal` 可省略 = 沿用）；单份清单总数上限 100 |
| `plan-reorder` | `{ order?: string[], updates?: [{ id, title?, note?, status? }] }`（两者至少一个） | `order` 必须是**当前全部 id 的一个排列**（少 / 多 / 重复都报错并列出差异）；`updates` 就地改标题 / 备注 / 状态 —— **"开始做某一项"也用它标 `in_progress`** |
| `plan-complete` | `{ ids: string[], note? }`（1..50） | 批量标 `completed`，幂等；未知 id 报 `invalid-input` 并列出当前清单 |
| `plan-delete` | `{ ids: string[] }`（1..50） | 批量删除；允许删空（`goal` 保留） |

四条设计口径：

1. **工具是增量的，协议仍是全量快照**：四个工具的出参**永远是完整清单**（`{goal, revision, tasks, summary, warnings?}`），
   于是「当前计划」仍然 = 该会话最后一条 `plan` 事件（`core/beans/planner/plan.protocol.ts` 的协议不变，前端与复盘不用改形状）。
   增量工具让模型一次只表达一件事（这几项完成 / 这几项删掉），清单长的时候省 token、也少一类"漏抄一项"的错；
2. **四个工具都 `child: 'deny'`**：清单归属发起这一轮的主 agent（子助手把结论交回父），
   顺带堵住"子 agent 的清单顶掉父的当前计划"；
3. **共同的内部机制**（`PlannerCore`）：读当前清单（本轮内存 → 时间线最后一条 `plan`，只看根 run）、
   同一轮串行（读改写不能并发）、**失败不改内存**（校验不过抛 `ToolDeniedError`，由网关翻成可纠正的结论）；
4. **状态纪律**：三态 `pending` / `in_progress`（同时只允许一个）/ `completed`；`plan-complete` 只做完成，
   开始做用 `plan-reorder`。多 `in_progress` 时出参带 `warnings`（**不阻断**，只提醒）。

旧的 `todo-write` **已删除**：库里的配置行按既定口径**保留**（"代码里删掉的工具不自动删配置行"，
历史 run 的时间线还引用它），运行时不再有它。
