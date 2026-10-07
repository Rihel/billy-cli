# 能力设计：该不该做、做多大、边界在哪（ai-agent-engineering 引用文件）

> 本文件是 `ai-agent-engineering` skill 的组成部分，由主 SKILL.md 引用。

定位：**动手加一个 AI 能力之前**的工程判断。机制怎么写（工具组 DSL / 注册机 / 网关插件 / 事件 / 适配器）见 `develop-ai-agent`，本文不重复。

## 1. 该不该做成 AI 能力

| 情形 | 判断 | 为什么 | 依据 / 位置 |
| --- | --- | --- | --- |
| 确定性逻辑（算价、状态流转、字段映射） | **不该** | 模型只是把确定性函数重新猜一遍：慢、不可测、会漂移 | 下沉到服务端代码，提示词不参与 |
| 需要真实外部数据（当前时间、文件、接口、库） | **该** | 模型的记忆不可信，答案只能来自执行 | `run-command`，`tools/command.tool.ts:188-211` |
| 需要多步推理与工具编排 | **该** | 单次推理收不了口，需要"边做边改计划" | `plan-*` 一组四工具，`tools/planner/planner.tools.ts` |
| 需要用户拍板（改配置、发布、删数据） | **不该直接做** | 模型替用户做了决定，责任链断了 | 一期靠纪律：有副作用的命令先问用户（`command.tool.ts:203-206`）；审批列三期（`docs/design/ai-agent-tool-engine.md:528`） |
| 破坏性动作（删除 / 覆盖 / 发布） | **可做，但必须带前置确认纪律** | 工具能做 ≠ 现在能做 | 纪律写进 `description` 的"纪律"段（同 `command.tool.ts:203-206`），并把动作与边界说清 |

一句话：**模型负责判断与编排，代码负责确定性与边界**。把确定性塞给模型，等于花钱买不确定性。

## 2. 粒度选择：单工具 / 工具组 / 子 agent

| 粒度 | 判据 | 范例 | 依据 |
| --- | --- | --- | --- |
| **单工具**（组里一个方法） | 一个动作、参数少、语义自洽 | `run-command` | `command.tool.ts:115-137`（`@ToolGroup` + 一个 `@ToolDecl`） |
| **工具组**（一组四个） | 同一件事的**不同动作**，每个动作的入参与纪律不同 | 规划：`create` / `reorder` / `complete` / `delete` | `planner.tools.ts:20-38`（设计 §3.16，取代单工具 `todo-write`） |
| **子 agent**（`run-sub-agent`） | 子任务**可独立完成**、独立后能一句话交代结论、需要多步探索 | 长文档撰写、批量核对、多方案并行的其中一路 | `tools/subagent.tool.ts:85-99` |
| **取页**（`read-tool-result`） | 大结果的回取通道，不是"新能力" | 任何声明了 `paginate` 的工具 | `tools/read-tool-result.tool.ts:14-23` |

**为什么规划是一组四个工具，不是一个万能工具**：一个 `todo-write` 要模型每次重写整份清单，且"改顺序 / 标完成 / 删一项"混在一个 schema 里，模型选不准、纪律也写不清。拆成四个后每个工具只讲一件事，出参统一是**完整清单快照**（`planner.tools.ts:34-37`），「当前计划」仍等于最后一条 `plan` 事件。

**工具面越大越贵**：每个工具的 `key` / `title` / `description` 都渲染进系统提示词（`core/prompts/templates/partials/tools.eta:6,11`）。工具越多、描述越长 → 前缀越长、选错概率越高。因此：一个方法一个工具；能复用不新增（见 §7）；没有合适的组才新建组。

## 3. 命名与描述数据结构

| 字段 | 数据结构 | 依据 |
| --- | --- | --- |
| `key` | **稳定对外标识**，唯一事实源为 `core/tools/tool-keys.ts`；禁止裸字符串（写错是编译期错误） | `tool-keys.ts:1-12`、`core/tools/tools.types.ts:282-283` |
| `title` | 人读标题，给模型扫读 + 后台列表 | `tools.types.ts:284-285`、`tool.registry.ts:96-104` |
| `description` | **唯一一份说明**，四段式：是什么 / 什么时候用 / 什么时候不用 / 纪律 | `tools.types.ts:286-287`、`tool.decorator.ts:68` |
| `params` | zod 定义，每个字段 `.describe()` 是**给模型的字段说明** | 范例 `command.tool.ts:16-37` |
| `config` | zod 定义，**每个字段必须 `.default()`**；`config.parse({})` 失败 → 启动即失败 | `tools.types.ts:293-299`、`tool.registry.ts:49-57` |

**为什么四段缺一个模型就会乱用**：

- 缺"是什么" → 模型只能靠标题猜语义；
- 缺"什么时候用" → 该用的时候想不起来（规划工具不写"多步任务先建清单"，模型就单步硬答）；
- 缺"什么时候不用" → 给单问单答套流程、把闲聊塞进规划（`planner.tools.ts:56-57` 明确写了这条）；
- 缺"纪律" → "删掉再新建来改任务""失败原样重试"这类错法没人拦（`planner.tools.ts:107-111`、`command.tool.ts:208-210`）。

两条硬要求：① 拒绝要说明理由并给下一步（`ToolOutcome.hint` / `precheck` 返回句，见 §4）；② 不要把业务规则写进描述冒充能力（见 §7）。

## 4. 权限与作用域

**两层关卡**：授权（agent 声明里有哪些 key，`agents/assistant.agent.ts:26-33`）∩ 作用域（这一次调用允不允许）。

| `scope` | 语义 | 判据 | 适用 |
| --- | --- | --- | --- |
| `all` | 任何调用者 | 直接放行 | 通用能力（规划 / 命令 / 子 agent 都是 `all`） |
| `admin` | 仅管理员触发 | `caller.isAdmin` | 管理台动作 |
| `user` | 仅前台用户触发 | `!caller.isAdmin` | 用户侧专有 |
| `agent` | 指定 agent | `allowedAgents.includes(caller.rootAgentKey)` | 只给某个角色 |

依据：`core/tools/plugins/scope.plugin.ts:13-53`；字典 `packages/shared/src/dicts/ai-tool.dict.ts:24-30`；`allowedAgents` 落 `ai_tools.allowed_agents`（`database/entities/ai-tool-entity.ts:79-81`）。

**两个轴**（声明在 `ToolSpec` / `@ToolGroup` 上，`tools.types.ts:311-316`）：

- `child: 'allow' | 'deny'`：子 agent 能不能用，**默认 allow**；
- `delegation: true`：委派类（创建 / 指挥子 agent），**隐含不能给子 agent**。

子 agent 工具面 = **全部 − 委派类 − `child: 'deny'`**（排除法，`core/tools/tool.registry.ts:122-135`）。深度天然封顶为 1：`run-sub-agent` 既是委派类又 `child: 'deny'`（`tools/subagent.tool.ts:69-70,81-82`）。

**身份怎么传下去**：编排层把 `AgentRuntimeEnvelope` 放进 `RequestContext`（`core/envelope.ts:38-69`），网关经 `toCaller` 转成 `ToolCaller`（`core/tools/tool.caller.ts:10-21`）。三个关键字段：

- `rootAgentKey`：**作用域按根 agent 判**，子 agent 沿用父的判定（`envelope.ts:51-52`、`tool.caller.ts:18-19`）；
- `agentKey`：子 agent 为 `sub:<名字>`，审计用；
- `depth`：根 0、子 1。

**拒绝要说明理由，不静默失败**：统一结论 `ToolOutcome`（`tools.types.ts:206-217`），reason 取自 `ToolDenyReasonValue`（`tools.types.ts:195-204`，字典 `ai-tool.dict.ts:39-49`）。执行体主动拒绝抛 `ToolDeniedError`，由网关翻成对应 reason（`tool.gateway.ts:131-140`）——**不是** `internal`（`internal` 才是我们写错了）。缺运行时身份时**拒绝并说明**，不伪造放行（`scope.plugin.ts:16-26`）。

## 5. 成本预算：每个能力都要报账

| 账目 | 手段 | 依据 |
| --- | --- | --- |
| 出参上限 | 声明 `paginate: { pageBytes }`；超限只把**第一页**给模型，返回值仍全量 | `tools.types.ts:317-318`、`core/tools/plugins/paginate.plugin.ts:9-14,32-47` |
| 取页 | `read-tool-result` + `limits.maxPagesPerTurn`（每轮次数） | `tools/read-tool-result.tool.ts:96-105` |
| 调用次数 | `limits.maxPerTurn`（按 run 计数）/ `limits.rateLimit`（按工具 + 用户，多实例走 Redis） | `plugins/rate-limit.plugin.ts:17-58`、`tool.rate-counter.redis.ts:10-14` |
| 事件刷屏 | 逐行事件必须有行数上限（超出**如实报数**、不静默丢），并给部署侧硬上限 | 机制见 §5.17；`run-command` 的流式事件已按用户口径移除（教训：只有出参**承载不了**的过程信息才值得发事件） |
| 子 agent 放大 | 一次委派 = 主 agent 现写提示词（≤8000 字）+ 子工具面 + 多步推理，N 次模型调用 | `subagent.tool.ts:19-37,44-53`（配额）、`runtime/agent-runner.ts:96-98`（默认 `maxPerRun=4` / `maxDepth=1`） |
| 部署兜底 | 库里的值一律被 env 硬上限夹紧 | `tools.types.ts:87-101`、`core/tools/tool.settings.ts:36-50`、`command.tool.ts:286-302` |

**两个必须知道的 token 事实**：

- 缓存读要读两处（顶层 `cachedInputTokens` 优先、嵌套兜底），只读嵌套会**永远 `null`** —— `runtime/usage.ts:14-19`；
- 提示词的**运行环境段只在会话开局注入一次**，每轮塞时间戳会让提供方前缀缓存每轮失效 —— `core/prompts/environment.ts:6-9`。

**"给模型一页 + 句柄"的取舍**：大结果全量落库、模型只拿第一页（`paginate.plugin.ts:44-47`），代价是模型可能看不到关键内容、要多一次取页往返。判断口径：**结果大且模型多半只需要其中一段 → 声明分页**；**结果小或每行都关键 → 不声明**。

## 6. 提示词与技能

- **工具清单从注册机来，不手抄**：`ToolRegistry.describe()` 的输出注入模板（`tool.registry.ts:96-104`、`agents/index.ts:23`、`partials/tools.eta:6`）。手抄必然与授权漂移。
- **工具说明只有一份**：提示词的「工具」段直接渲染 `description`，与模型选工具看到的是同一份（`tools.eta:9`）——两处写必然漂移。
- **模板是提示词的唯一出口**：`core/prompts/prompt.engine.ts:33-41`；运行环境片段由 `core/prompts/environment.ts` 组装、`partials/environment.eta` 排版。
- **技能是按需加载的说明书，不是工具**：`SkillLoader` 扫 `catalog/<name>/SKILL.md` 与 `references/`（`core/skills/skill.loader.ts:139-151`），启动期校验、agent 按名声明；技能不进工具面，模型不会把它当动作调用。
- **注意运行时自带工具**：配了技能后 Mastra 自动挂 `skill` / `skill_search` / `skill_read`（`tool-keys.ts:45-67`）——它们不进注册机、**不受开关与限额控制**，后台清单要单独对账。

## 7. 什么时候不该加工具（反模式）

| 反模式 | 症状 | 正确做法 |
| --- | --- | --- |
| 已有工具能表达 | 新 key 与旧 key 语义重叠 | 往已有组加一个方法，或让模型组合现有工具 |
| 模型一次推理就能做 | 工具只是包了一层格式化 | 写进提示词，或让模型直接答 |
| 需要人拍板 | 工具直接改了外部状态 | 先用描述里的纪律问用户；审批机制到位前不加 |
| 业务规则塞进工具描述 | 描述里写"金额大于 100 要…" | 规则进服务端代码；描述只讲适用与纪律 |
| 为了绕开权限而新开工具 | 同一动作两个 key、scope 不同 | 修作用域 / 授权，不复制能力 |
| 只把过程写进事件 | 刷新后查不到 | 结论写进出参（出参全量落库） |

## 8. 决策清单

- [ ] 这件事**必须**由模型判断吗？确定性部分已下沉到代码吗？
- [ ] 粒度选了哪种（单工具 / 工具组 / 子 agent / 取页）？理由能对应到 §2 的判据吗？
- [ ] `key` 取自 `TOOL_KEYS`、无裸字符串？`title` 能扫读？
- [ ] `description` 四段齐全？"什么时候不用"写了吗？纪律能拦住已知的错法吗？
- [ ] 每个 `params` 字段有 `.describe()`？`config` 每个字段有 `.default()`（`parse({})` 成功）？
- [ ] `scope` / `allowedAgents` / `child` / `delegation` 都**显式**定过（不是默认撞上的）？
- [ ] 出参上限与分页声明过？调用次数 / 事件行数的限额定过？被 env 夹紧的路径确认过？
- [ ] 提示词工具段来自注册机（改授权后不手改模板）？技能没有被当成工具用？
- [ ] 对照 §7 反模式逐条排除过？
