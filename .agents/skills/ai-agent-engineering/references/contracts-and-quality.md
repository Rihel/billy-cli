# 数据结构与质量：三轨闭环 / 流协议 / 测试分层 / 验收（ai-agent-engineering 引用文件）

> 本文件是 `ai-agent-engineering` skill 的组成部分，由主 SKILL.md 引用。

前置：机制（工具组 DSL、注册机、网关插件、适配器映射、提示词引擎）见 `develop-ai-agent`；
写测试的通用套路见 `write-tests`，前端组件与设计 token 见 `develop-frontend-page`。

## 1. 数据结构三轨：shared schema → 服务端 → SDK → 页面

| 轨 | 文件 | 谁读它 |
| --- | --- | --- |
| 数据结构 | `packages/shared/src/schema/ai-tool.schema.ts`（对外模型 `:64-106`、入参 `:132-142`、限额 `:31-48`、秘钥字段 `:53-60`）；`ai-tool-event.schema.ts`（声明 `:31-42`、流 part `:81-85`、`TOOL_EVENT_PART_TYPE` `:47`） | 服务端与前端**共用同一份 zod** |
| 服务端 | `api/ai-tool.controller.ts` + `api/ai-tool.service.ts` + `core/tools/tool.config.repository.ts`（`ai_tools` 表）+ `core/tools/tool.seed.service.ts`（启动期镜像） | 落库与读库 |
| SDK | `packages/sdk/src/server.client.ts`：`aiTool.list/detail/update/reset`（`:532-541`）、`chatStreamUrl` / `resumeStreamUrl`（`:437-449`）、`stop`（`:380`） | admin 只经 SDK 调接口 |
| 页面 | `apps/admin/src/app/main/ai/tools/**`（`page` / `tool-form` / `tool-columns` / `config-panels` / `tool-events` / `tool-payload`） | 管理员 |

- **改数据结构后必须 `pnpm build:pkgs`**：类型走源码、**运行时走 `dist`**；不跑就出现"类型过了、运行时还是旧字段"。
- **基础信息是代码的镜像**：`title` / `description` / `category` / `param_schema` / `events` 由启动期种子
  **全量覆盖写**（代码声明是唯一事实源），页面只读；`runtime` 工具 `editable: false`（`ai-tool.schema.ts:9-16, 67-70, 90-96, 99-100`）。
- **前端只配"配置"**：`AiToolUpdateSchema` 只有 `toolKey` / `enabled` / `scope` / `allowedAgents` / `config` /
  `secrets` / `limits`（`:132-142`）——**不接受** `title` / `description` / `param_schema` / `events`。
  提交体由 `tool-payload.ts:111-148` 构造，同样没有基础信息。
- `config` 与 `limits` 是**整列替换**（jsonb 不按 key 合并，`:128-131`；`tool-payload.ts:134-136`）——
  所以前端提交"整份生效配置"，这样"把某一项改回默认值"才表达得出来。

## 2. 流协议：`data-*` part 清单

| part | 谁发 | 带 id？ | 落库？ | 前端渲染 |
| --- | --- | --- | --- | --- |
| `data-run` | `chat.service.ts:792-798`（本轮身份，**第一个块**） | 否 | 否 | `message-row.tsx:185-187` 返回 null；`chat-conversation.tsx:242-256` 记 runId + 新会话换地址 |
| `data-run-usage` | `chat.service.ts:894-906`（终态落库之后、`[DONE]` 之前） | 否 | 否 | `message-row.tsx:188-191` null；由 `data.ts:85-92` 消费 → `chat-conversation.tsx:482` |
| `data-conversation-title` | `chat.service.ts:863-875`（只在真改过名时发） | 否 | 否 | `message-row.tsx:192-196` null；`onData` `chat-conversation.tsx:218-239` 就地改缓存 |
| `data-tool-event` | `core/tools/tool-event.ts:184-197` | `state` 带 `<toolCallId>:<事件名>`；`stream` 不带（由 `mode` 决定） | 否 | `message-row.tsx:151-161`：并进对应工具卡，无主的独立成卡 |
| `data-sub-agent` | `agent-runner.ts:561-565`（子助手状态快照） | **是**，`id = subRunId`（同 id 覆盖） | 否 | `message-row.tsx:162-174` → `SubAgentPanel` |
| `data-sub-agent-delta` | `agent-runner.ts:548-551` | 否（一块一个） | 否 | `message-row.tsx:175-178` null（已并入面板） |
| `data-plan` | **服务端不发**；只有 `history.ts:246-252` 从 `kind='plan'` 时间线行合成 | 是（`plan-<seq>`） | 源头是 `plan` 时间线行（`stream-recorder.ts:135-143`） | `message-row.tsx:142-150`：被 `PlanPanel` 吸收，否则露徽标 |
| `data-status` | **当前仓库内无发射方** | — | 是（录成 `kind='status'` 行，`stream-recorder.ts:195-201`） | 无分支 → 落进未知 part 徽标（`message-row.tsx:197-202`） |

- **落库的判定点是录制器的 `default` 分支**（`stream-recorder.ts:202-204`）：`start` / `finish` /
  `start-step` / `finish-step` 与**未知 `data-*` 一律不落行**；步骤行在 `finish()` 里统一补（`:226-238`）。
  于是"事件是过程、出参是结论"在代码上是**一个 switch 的距离**——刷新后还要看见的东西必须写进出参。
- **未知 part 必须看得见**：`message-row.tsx:197-202` 渲染一个 `data-xxx` 徽标，**不许静默丢**；
  事件 part 侧同理，`parseToolEventPart` 是宽容解析（`ai-tool-event.schema.ts:90-97`），解析不出返回 null 交给未知分支。
- **id 有无 = 归并策略**：AI SDK data part 按 id 归并（同 id 后者覆盖前者），所以**增量绝不能带固定 id**
  （否则只剩最后一块）；这条判断在服务端做（`tool-event.ts:18-20`），前端不自己实现去重。

## 3. 历史与实时同构

`history.ts` 的 `toUIMessages`（`:46-126`）把时间线**合成**成同一种 `UIMessage.parts`，让同一套渲染分支吃两种来源：

| 时间线 kind | 合成 | 行 |
| --- | --- | --- |
| `text` | `{ type: 'text' }` | `:201-205` |
| `reasoning` | `{ type: 'reasoning', state: 'done' }` | `:206-210` |
| `tool-call` | `dynamic-tool` 卡**就地铺开**（结果到达时就地补出参，位置不变） | `:211-231`（`:158-165`） |
| `plan` | `data-plan` part，攒到最后追加（与实时"当前计划在消息末尾"一致） | `:232-252` |
| `run-sub-agent` 的结果 | 额外合成 `data-sub-agent`（与实时流同结构，面板只认它） | `:167-181` |
| `runs` 行的用量 | 追加 `data-run-usage`（实时是收尾下发，历史只能从 `runs.usage` 重建） | `:100-115` |

**漏了会怎样（都是实际踩过的）**：
- 工具卡攒到最后统一追加 → 刷新后卡全被挪到消息末尾，与实时形态对不上（`:186-189`）；
- 不补 `data-run-usage` → 回看历史只剩正文、统计全空（`:100-101`）；
- 消息 id 自己拼 → 重连补发时 SDK 认不出是同一条，同一个回答出现**两份**（`:72-83`）；
- 一个 part 都铺不出来 → 不生成这条消息，否则界面上是个"（空消息）"气泡（`:117-122`）。

**顺序纪律**：parts 顺序 = 时间线 `seq` 顺序 = 实时流的到达顺序；**绝不重排**（重排等于篡改历史，
`tool-event.tsx:186`）。

## 4. 事件渲染闭环

| 环节 | 规则 | 位置 |
| --- | --- | --- |
| 注册表 | 模块级 Map `toolKey → event → renderer`；写入是**覆盖式**（HMR 重跑模块幂等） | `tool-event.tsx:54-71` |
| 选取优先级 | 精确（toolKey+event）> 工具通配（toolKey+`*`）> 全局精确（`*`+event）> 全局通配（`*`+`*`）> 内置兜底 | `:89-102` |
| 分组 | **只有一条规则**：相邻的 `stream` 块并进同一组（不论事件名），`state` 块单独成组并切开流水 | `:188-202`（`:193` / `:199`） |
| 兜底 | 标题 + 事件名徽标 + 按 `mode` 画（`stream` 一行带真实 `seq`；`state` 键值表；结构化值退折叠 JSON） | `:271-296`；选择处 `:299-303` |
| 边界 | 渲染器**只画正文**；标题 / 事件名徽标 / `mode` 由卡片统一画 | `:43-52`；`run-command.renderer.tsx:15-16` |

- **注册发生在模块加载期**：`run-command.renderer.tsx:238-239` 在模块顶层调用注册函数，
  **唯一接线处**是 `chat-conversation.tsx:49` 的 `import './renderers/run-command.renderer'`。
  漏了这行 import → 命令输出**静默**退回兜底渲染（不报错、不白屏，只是长得不对）——新增渲染器必须补这行。
- 自定义渲染器放 `apps/admin/src/app/(standalone)/main/ai/chat/renderers/<tool>.renderer.tsx`；
  测试可用 `resetToolEventRenderers()`（`:79-81`）清注册表，避免用例互相污染。
- 无主事件（子 agent 内部工具发的 / 非流式调用）**独立成卡**，不消失（`message-row.tsx:41-42, 151-161`；
  分桶逻辑 `tool-event.tsx:128-151`）。

## 5. 配置闭环

- **`ai_tools` 行从哪来**：启动期 `ToolSeedService` 把代码声明**覆盖写**成基础信息（代码是唯一事实源）；
  配置只能由后台改。行上的 `created_by` / `updated_by` 由 `AuditSubscriber` 自动填（`audit-entity.ts:15-19`）。
- **后台展示的边界**：`tool-form.tsx:243-297` 的「工具信息（只读）」+「自定义事件（只读）」；
  `tool-events.tsx:10-17` 明写只读、**不提供编辑入口**；`tool-columns.tsx:128-133` 列表里的 title 也是只读镜像。
- **可配的是**：治理（`enabled` / `scope` / `allowedAgents`）、限额、工具专属 `config`、秘钥（`tool-form.tsx:299-443`）。
- **`config-panels.tsx` 是手写字段清单**：`RUN_COMMAND_FIELDS`（`:40-79`）/ `RUN_SUB_AGENT_FIELDS`（`:82-107`）
  显式枚举字段名与 hint，`fieldsOf` 按 tool key 分支（`:127-132`）；注释自证"一期按工具手写"（`:7`）。
- **新增 config 字段的正确做法**：先给代码默认值，**再补面板**。兜底面板会按 `Object.keys(defaultConfig)`
  渲染（`:117-124`），所以新字段**不会配不到**；但会丢 `hint` / `min` / 单位与"填大了会被 env 夹紧"这类口径
  （例如「时长上限」这类会被部署边界夹紧的字段），配错的代价由管理员承担 → 仍要补面板。

## 6. 测试策略（分层，每层钉什么）

| 层 | 文件 / 命令 | 钉什么 |
| --- | --- | --- |
| 纯函数单测 | `test/ai-context` / `ai-usage` / `ai-title` / `ai-tool-paginate` / `ai-tool-settings` / `ai-prompt-guardrails` | 判定与归一化逻辑，不需要 DB / Redis / 模型 |
| 规范工具单测 | `test/ai-tools/<key>.test.ts`（当前 7 个，与 `TOOL_KEYS` 一一对应） | 单个工具的入参 / 出参 / 拒绝路径 |
| 标准测试集 | `pnpm --filter @app/server test test/ai-tools-battery.test.ts` | 结构不变量（`:48-130`、`:140-144`）+ **文件存在性**（`:132-138`） |
| 适配器行为约定 | `... test/ai-mastra-contract.test.ts` | 用例 ①durable 下 `toModelOutput` 生效（`:119-140`）/ ①-b 对照（`:141-150`）/ ②`beforeToolCall` 可短路（`:151-183`）/ ③未知工具不炸整轮（`:184-201`），全程 `durable: true`（`:104`） |
| e2e | 4 份 `test/ai-*-e2e.test.ts` + `test/ai-durable-stream.test.ts` | 真实 DB + 真实 Redis + 离线 mock 模型的端到端链路 |
| 前端渲染 | `apps/admin/test/*.test.ts`（9 份） | `renderToStaticMarkup` SSR 冒烟 + 纯函数（`tool-card.test.ts:2`）；**不装 jsdom / happy-dom**，不许为测试加 DOM 依赖 |

- **标准测试集的两类断言**：结构（key 属 `TOOL_KEYS`、说明 > 60 字、`config.parse({})` 必须成功、secrets 不产明文、
  委派类必须 `child: deny`、`childToolbox` 走排除法、重复 key / 空池装配期报错）+ 文件存在性
  （文件名 = **注册机 spec 的 key** + `.test.ts`，`:135`）。
- ⚠️ **battery 里的工具组是测试内手写的 4 个**（`:35-40`），**不读生产的 `AGENT_TOOL_GROUPS`**（登记处
  `ai.module.ts:113-117`）。所以新增一个工具组后：battery 不会自动覆盖它 —— 必须**先登记进 battery 的 groups，
  否则那个组的工具完全不被断言（静默漏测）**；生产装配另在 `ai.module.ts` 登记一行。
- **升级 `@mastra/core` 先跑一致性测试**（`ai-mastra-contract.test.ts:9-11`）：挂了说明 `ai/mastra/**` 适配器要改，
  主体 `ai/tools/**` 不受影响。
- **e2e 的离线标记**（写在用户消息里，`helpers/mock-model-server.ts`）：`[command]`（`:166`）、`[delegate]`（`:152`）、
  `[todo-overwrite]`（`:70`）、`[todo-react]`（`:109`）、`[child]`（`:149`）、`[slow]`（`:188`，验证停止与补发）、
  `[events]`（`:192`，验证 `data-tool-event`）；无标记默认发 `plan-create`（`:333`），命名轮靠"请求里没有 tools"识别（`:398-399`）。
  mock 监听 `127.0.0.1` **随机端口**（`:505`），**不依赖任何外部密钥**（`:5`）；库相关 e2e 需要真实 `DB_URL` 与 Redis，
  且 `apps/server/vitest.config.ts:12` 设了 `fileParallelism: false`（**串行**，别指望加并行提速）。
- **新增 AI 能力优先给 mock 加一个标记 + 一条 e2e** —— 这是"能力真的能从 UI 走到底"的唯一证据。

## 7. 可测性硬要求

- **依赖走 DI**：容器装配的类每个构造器参数显式 `@Inject(token)`（`check:inject` 守，
  `scripts/check-inject-decorators.ts:1-16`）；漏写在开发态（tsx/esbuild）会**静默注入 `undefined`**，运行时才炸。
  反过来：不经过容器的类**刻意不写**装饰器（如 `StreamRecorder`，`stream-recorder.ts:48`）。
- **逻辑抽纯函数**：分页（`paginate.ts`）、配置合并（`tool.settings.ts:58-94`）、事件分组（`tool-event.tsx:188`）、
  渲染器选取（`:89`）、历史合成（`history.ts:46`）、计划归一（`plan-panel` 的 `collectMessagePlan`）——
  于是这些"最容易错、最该被断言"的判定不需要 DB / DOM。
- **测试装配辅助**（`test/helpers/ai-tool-stack.ts`）：`buildToolStackDeps`（`:99-126`，默认装**与生产同序的 9 个插件**）、
  `makeToolContext`（`:134-169`，默认给根 agent 的前台用户身份；测无信封分支显式传 `caller: null`）、
  `specByKey`（`:185-189`）、`MemoryToolConfigSource`（`:34-60`）、`TEST_TOOL_ENV_CAPS`（`:71-80`）。
  要断言 `ctx.emit` 的事件**必须走 `gateway.invoke` + 假 writer**——`makeToolContext` 给的 `emit` 是 no-op（`:163-168`）。
- **带装饰器的夹具只能放 `src/**`**：`test/**` 不做 TS 装饰器转换（`SyntaxError`）→ 放
  `src/modules/ai/tools/*testkit*.ts`、**不进 `AGENT_TOOL_GROUPS`**，并靠 `apps/server/tsconfig.build.json:3`
  的 `**/*testkit*.ts` 排除出构建产物（生产误引则构建失败，是刻意的哨兵）。
- 时间与计数走端口（`ToolClock`，`tools.types.ts:81-84`；`TOOL_RATE_COUNTER`，`tool.ports.ts`），
  测试换内存实现即可，不必 sleep、不必连 Redis。

## 8. 质量检查与验收

```bash
pnpm --filter @app/server test test/ai-tools-battery.test.ts     # 标准测试集（每个工具）
pnpm --filter @app/server test test/ai-mastra-contract.test.ts   # 适配器行为约定（升级 Mastra 先跑）
pnpm --filter @app/server test                                   # 含真实 Redis 的 e2e（串行）
pnpm build:pkgs                                                  # 改了 @repo/shared / @repo/sdk 后必跑
pnpm typecheck && pnpm test && pnpm check:ui && pnpm check:inject && pnpm check:mastra
```

| 门 | 命令 | 守什么 |
| --- | --- | --- |
| 类型 / 单测 | `pnpm typecheck` / `pnpm test`（`package.json:19-20`，turbo） | 全仓编译与测试 |
| UI | `pnpm check:ui`（`scripts/check-ui.ts`，五条不变量见文件头 `:1-35`） | 组件导出 / 前端包 typecheck / 禁硬编码调色板 / 样式入口 / 字体规范 |
| DI | `pnpm check:inject`（`scripts/check-inject-decorators.ts`） | 构造器 `@Inject` 不漏、`providers` 裸类名有 `@Injectable()` |
| Mastra 边界 | `pnpm check:mastra`（`scripts/check-mastra-boundary.ts`） | `core/tools/**` 与 `tools/**` **禁 import `@mastra`**（`:22-25`）；其余文件走**只减不增**的允许清单（`:37-44`） |

**验收法：四者对账** —— 同一个能力，四处必须能互相对上：

| 对账面 | 去哪看 |
| --- | --- |
| **模型看到的** | `toModelOutput` 的投影 + `ContextSnapshot`（`runs.request_snapshot.context`）+ `configVersion` |
| **库里存的** | `timelines` 的入参出参全量（**不裁剪**）+ `runs.usage` + `kind='plan'` / `summary` / `status` 行 |
| **界面渲染的** | `message-row.tsx` 的分支 + 自定义渲染器（含未知 part 徽标） |
| **审计查得到的** | `tool-result` 行的 `payload.outcome`（含 `configVersion` / `durationMs` / `page`）+ 结构化日志 `ai.*` + `runs.request_id` |

对不上的地方，**要么是明确记录的取舍**（写进设计文档与注释），**要么是 bug** —— 没有第三种。

## 9. 自查清单

- [ ] 改了 `@repo/shared` 的数据结构后跑了 `pnpm build:pkgs`，并且 SDK / 页面同步改了？
- [ ] 新增的 part / 事件是"加"不是"改"（旧客户端认不出时**看得见**，兜底分支没被删）？
- [ ] 新增的 `data-*` part 在前端有明确分支（渲染、或显式 `return null` 并写清为什么不展示）？
- [ ] 新渲染器文件在会话页**有 import**（模块加载期注册），并且加了 `resetToolEventRenderers` 可测？
- [ ] 历史合成路径也照顾到了新内容（刷新 / 切会话后与实时流长得一样）？
- [ ] 新增的 `config` 字段有默认值 + 在 `config-panels.tsx` 有面板（或确认兜底面板可接受）？
- [ ] 新工具：`test/ai-tools/<key>.test.ts` 已存在（文件名 = 注册机 spec 的 key）？
- [ ] 新工具组：**同时**登记进生产的 `AGENT_TOOL_GROUPS` 与 battery 的 groups（否则静默漏测）？
- [ ] 改了适配器 → 跑了 `ai-mastra-contract`；改了 `core/tools` → 跑了 `pnpm check:mastra`？
- [ ] 新能力优先给 `mock-model-server.ts` 加了标记 + 一条 e2e，而不是只写单测？
- [ ] 前端渲染断言走 SSR 冒烟 / 纯函数，没有为它引入 jsdom 之类的新依赖？
- [ ] 这条能力的四者对账（模型 / 库 / 界面 / 审计）当场走通了一遍？
