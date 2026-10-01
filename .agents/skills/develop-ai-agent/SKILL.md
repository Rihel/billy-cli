---
name: develop-ai-agent
description: >-
  在 Billy 工程（billy-cli）中开发 / 扩展 AI 能力（`apps/server/src/modules/ai`）：新增 agent、
  新增工具（**工具组 + 方法即工具**：`@ToolGroup` + 方法级 `@ToolDecl` + 注册机 + 网关插件；规划 /
  子 agent / 取页）、工具配置入库与后台配置页、Mastra 适配器边界、
  新增技能（SkillLoader catalog）、写提示词（eta 模板）、改会话 / 运行 / 时间线落库与 SSE 流式协议、
  动态子 agent、上下文裁剪与压缩、崩溃恢复与看门狗。触发词：AI、agent、agent key、工具、
  tool、工具组、@ToolGroup、@ToolDecl、装饰器、ToolSpec、ToolRegistry、注册机、ToolGateway、网关、插件、plugin、
  ai_tools、工具配置、planner、子 agent、sub-agent、技能、skill、提示词、prompt、eta、
  会话、conversation、run、运行、时间线、timeline、流式、SSE、AI SDK、Mastra、token 消耗、
  上下文压缩、恢复、看门狗。
---

# 开发 AI 能力（`modules/ai`）

前置：先加载必读 skill `billy-dev-foundation`；数据结构改动配合 `define-data-structure` /
`database`，接口质量自查看 `develop-backend-api`，写页面看 `develop-frontend-page`。
**权威设计文档**：`docs/design/ai-agent.md`（运行时）+ `docs/design/ai-agent-tool-engine.md`
（工具 DSL / 注册机 / 网关插件 / 配置入库 / Mastra 适配器）—— 改 AI 前先读，改完同步。

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
| `core/` | 机制层（与具体 agent 无关）：`ai.config` / `ai.types` / `ai.core.types` / `ai.registry` / `ai.service` / `ai.errors` / `ai.constants` / `ai.model-decision`；**工具组在 `core/beans/`**：`command.tool` / `subagent.tool` / **`planner/`**（规划工具组 `planner.tools`：组内四个 `@ToolDecl` 方法 + `planner.store` 机制 + `planner.schemas` 契约 + `plan.protocol` 计划协议） | 加工具：在合适的组里加一个 `@ToolDecl` 方法（没有合适的组就新建一个 `@ToolGroup` 类）+ 在 `AGENT_TOOL_GROUPS` 登记一行 |
| `tools/` | **工具主体**（禁 import `@mastra`）：`tools.types`（DSL）/ `tool.decorator` + `tool.class`（工具组 DSL 与 `buildToolSpecs`）/ `tool.registry`（注册机 + 种子）/ `tool.gateway`（网关）/ `plugins/*.plugin.ts`（一个插件一个文件）/ `tool.settings`（合并纯函数）/ `tool.config.service`（缓存）/ `tool.config.repository`（`ai_tools`）/ `paginate` + `read-tool-result.tool`（大返回分页与回取）/ `ai-tool.service`（后台工具配置服务） | 加工具：在工具组里加一个 `@ToolDecl` 方法 + `AGENT_TOOL_GROUPS` 一行 + `TOOL_KEYS` 一个 key + `test/ai-tools/<key>.test.ts`（标准测试集强制） |
| `mastra/` | **适配器**（唯一可 import `@mastra`）：`ai.mastra`（Mastra 实例装配）/ `tool.adapter`（含 `toModelOutput` 分页）/ `agent.adapter` / `context.adapter`（信封 ↔ RequestContext）/ `stream.adapter` / `skill.adapter` | 升级 Mastra 先跑 `test/ai-mastra-contract.test.ts` 的契约，再改这里 |
| `agents/` | **顶层** agent 声明（前端能选的就这些）+ `index.ts` 唯一登记处 | 加 agent：一个文件 + `AGENT_SPECS` 一行 + 一个 eta 模板 |

| `prompts/` | 提示词引擎 + `templates/*.eta` + `partials/` + 运行环境组装（`environment.ts`，见 `extension.md` §8） | 模板变量由装配层注入（工具清单来自 `ToolRegistry.describe`）；按轮求值的片段走 `renderPartial` |
| `skills/` | `SkillLoader` + `catalog/<name>/SKILL.md`（+ `references/`） | 加技能：一个目录 + 在 agent 声明的 `skills` 里授权 |
| `runtime/` | 会话 / 运行 / 时间线仓储与服务、上下文、流记录、子 agent 执行器、看门狗 | 改行为先看 `runtime.md` |

细节：会话运行链、上下文策略、SSE 协议与恢复 → [references/runtime.md](./references/runtime.md)；
扩展点（加 agent / 工具 / 技能 / 子 agent）→ [references/extension.md](./references/extension.md)。

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

**两个只在启动时才暴露的坑**（各踩过一次，`test/app-bootstrap.test.ts` 现在守着）：

1. `exports` 里写了一个没在 `providers` 里提供的 token → `UnknownExportException`（类型检查与单测都发现不了，
   因为单测是手工 `new` 的）；
2. **工厂型 provider 成环 → Nest 不报错、直接静默死锁**（现象：进程 CPU 0%、永远停在启动中）。
   踩过的那条环是 `ToolRegistry → AGENT_TOOL_GROUPS → RunSubAgentTool → AgentRunner → ToolRegistry`；
   解法是让 `AgentRunner` 用 `ModuleRef` **惰性取**注册机（`this.moduleRef.get(ToolRegistry, { strict: false })`），
   构造期不依赖它。要读容器的类一律照这个办法。

## 2.1 如何新增一个工具（工具组：方法即工具）

**先找组**：能放进已有工具组就加一个方法；没有合适的组就新建一个组类
（`core/beans/<名字>.tool.ts` 放与业务无关的运行时能力，`tools/<名字>.tool.ts` 放工具主体）。

1. **组类**（新建时才要）：`@Injectable()` 类 + 类上 `@ToolGroup({ category?, scope?, child? })`
   给组内工具共同默认值；依赖（仓储 / 执行器 / 日志）**全部走构造器 `@Inject`**，组内工具共享；
2. **方法 + 方法级 `@ToolDecl({...})`**（**一个方法 = 一个工具**，声明与执行体同一处）：
   `key` 取自 `TOOL_KEYS`（先在 `tool-keys.ts` 加一个 key）；`params` / `config` 用**同一文件里的
   模块级 zod 常量**（不能引用本类 static —— 装饰器在类定义期求值）；`config` 每个字段都必须 `.default()`；
   `description` 写"是什么 / 什么时候用 / 什么时候不用 / 纪律"；
3. **钩子按方法名写在声明里**：`precheck: 'checkXxx'`（只读前置条件）/ `normalize: 'normalizeConfig'`
   （把配置夹到部署上限）；被指向的方法写成组类的普通方法。执行体只写业务动作 —— 开关、边界、分页、
   审计都在网关插件里；
4. **装配**（新建组才要）：`ai.module.ts` 的 `AGENT_TOOL_GROUPS` 工厂 `inject` 里加这个组，
   并在 `providers` 里加一行；子 agent 不能用的在 `@ToolGroup` / `@ToolDecl` 标 `child: 'deny'`，
   委派类标 `delegation: true`；
5. **测试与授权**：写 `test/ai-tools/<key>.test.ts`（标准测试集强制：`specByKey(new MyTools(...), key)`
   或 `buildToolSpecs(group)` 拿 spec 直接调 `exec`），并在 `agents/assistant.agent.ts` 的授权清单加 key。

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

## 3. 验证与质量门

```bash
pnpm --filter @app/server test test/ai-plan-subagents.test.ts   # 规划 / 子 agent / 审计
pnpm --filter @app/server test test/ai-tools-battery.test.ts    # 注册机标准测试集（每个工具）
pnpm --filter @app/server test test/ai-mastra-contract.test.ts  # 适配器契约（升级 Mastra 先跑）
pnpm --filter @app/server test                                  # 含真实 Redis 的流式 e2e
pnpm typecheck && pnpm test && pnpm check:ui && pnpm check:inject && pnpm check:mastra   # 全仓门
```

**两条铁律（工具引擎按它写，别的包同样适用）**：文字性多行字符串一律 ``dedent`...` ``；
除纯类型文件外**一个文件一个职责**（见 `billy-dev-foundation/references/code-conventions.md` 第 11 / 12 条）。

## 4. 工具配置的三条口径（2026-10-01 定，改之前先看）

1. **基础信息留在代码、启动期全量镜像入库**：`title` / `description` / `category` / `param_schema`
   由 `ToolSeedService` 每次启动按声明**覆盖写**（代码是唯一事实源）；后台页只读展示，**不提供编辑**。
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
  时间线事件，「当前计划」= 最后一条（`core/beans/planner/plan.protocol.ts` 的 `PLAN_TOOL_KEYS` 要跟着登记新 key）；
- **四个都 `child: 'deny'`**（只给主 agent），内部共享"本轮内存 → 时间线 + 同轮串行 + 失败不改内存"的机制；
- 加第五个规划工具时：`tool-keys.ts` 加 key → `PLAN_TOOL_KEYS` 登记 → 在 `PlannerTools` 里加一个
  `@ToolDecl` 方法（`PlannerStore` 已在组构造器注入）→ `assistant.agent.ts` 授权 → `test/ai-tools/<key>.test.ts`（标准测试集强制）。

- **离线 mock 模型**在 `test/helpers/mock-model-server.ts`（`[todo-overwrite]` / `[todo-react]` /
  `[delegate]` / `[command]` / `[slow]` 标记），
  不需要任何外部密钥；新增能力优先给它加一个标记 + 一条端到端断言；
- 改契约（`@repo/shared`）后**必须** `pnpm build:pkgs`，否则 `@repo/*` 仍解析 dist；
- 迁移：`pnpm --filter @app/server db:generate <名字>` → 迁移文件首行改 `import type`，
  并**人工检查部分索引（partial unique）的条件变化**（TypeORM 检测不到）。
