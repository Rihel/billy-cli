# 安全与审计：越权 / 秘钥 / 命令 / 注入 / 留证（ai-agent-engineering 引用文件）

> 本文件是 `ai-agent-engineering` skill 的组成部分，由主 SKILL.md 引用。

定位：**边界怎么守、证据怎么留**。机制（插件怎么写、事件怎么发、适配器怎么接）见 `develop-ai-agent`。数据建模看 `database`，接口质量看 `develop-backend-api`。

## 1. 权限链全貌：每一环漏了会怎样

| 环节 | 在哪 | 做什么 | 漏了会怎样 |
| --- | --- | --- | --- |
| HTTP 身份 | `api/ai.controller.ts:55-56`（`AnyAuthGuard`） | 认人：`isAdminIdentity()` 判管理员、`ownerId()` 取发起人 | 无身份或身份混淆 → 越权 |
| 运行时信封 | `core/envelope.ts:38-69` | 把会话 / 根 agent / 深度 / 模型 / 子工具面 / `isAdmin` 送进调用 | 工具拿不到身份，作用域判不了 |
| `ToolCaller` | `core/tools/tool.caller.ts:10-21` | 信封 → 调用方的纯映射（无信封为 `null`） | 伪造放行（当前实现：无信封 = 拒绝） |
| 插件关卡 pre | 顺序 `enabled → scope → rate-limit → validate → precheck → audit-start`（`ai.module.ts:144-163`） | 开关 / 权限 / 限流 / 入参 / 前置条件 | 漏哪一环，那类调用就无条件放行 |
| 执行体 | `tools/**` | 只写业务动作 | 边界判断散进业务，新工具必漏 |
| 插件关卡 post | 顺序 `redact → paginate → audit-end` | 脱敏 / 分页给模型 / 审计 | 秘钥进日志、大结果灌上下文、查无实据 |

纪律：**数组顺序就是执行顺序**（`core/tools/tool.gateway.ts:19,90-98,104-116`）；安全类插件只累积拒绝、不互相覆盖（`tools.types.ts:373-377`）；**被拒绝的调用也要跑 post**（拒绝必须被记下来，`tool.gateway.ts:103`）。

## 2. 作用域与授权

**"谁算 admin"来自 HTTP 层**：`api/ai.controller.ts:81-83` —— 有 `userId` 就是前台用户，只有 `adminId` 才是管理员；该判据随 `chat()` / `chatStream()` 的 `isAdmin` 参数进信封（`runtime/chat.service.ts:1105-1112`）。**不由模型决定，也不接受前端传**。

| `scope` | 含义 | 判定 |
| --- | --- | --- |
| `all` | 所有调用者 | 放行 |
| `admin` | 仅管理员 | `caller.isAdmin` |
| `user` | 仅前台用户 | `!caller.isAdmin` |
| `agent` | 指定 agent | `allowedAgents.includes(caller.rootAgentKey)` |

依据 `core/tools/plugins/scope.plugin.ts:13-53`。三条要点：

1. **授权清单在 agent 声明里**（`agents/assistant.agent.ts:26-33`），不在库里 —— 库里只控制"这一次允不允许"，改不了"这个 agent 有没有这个工具"；
2. `allowedAgents` 与 `scope='agent'` 配套，落 `ai_tools.allowed_agents`（`database/entities/ai-tool-entity.ts:79-81`）；
3. **子 agent 沿用根 agent 的判定**（`envelope.ts:51-52`、`tool.caller.ts:18-19`）：换个 `agentKey` 拿不到父没有的权限。

**现状缺口**：工具面是**装配期快照** —— 后台关掉一个工具，提示词里仍列着它，只是调用被拒（`docs/design/ai-agent-tool-engine.md:454-456`）。要让模型"看不见"需要重启，动态工具面列二期。

## 3. 秘钥

**明文入库是明确取舍，不是疏漏**（2026-10-01 决定，含 `ai_providers.api_key`）：

- `ai_tools.secrets` 直接存明文（`database/entities/ai-tool-entity.ts:87-95`）；提示串在**读取时**由 `hintOf` 从明文派生（`apps/server/src/modules/ai-model/secret-hint.ts`、`core/tools/tool.settings.ts:87-92`）；
- **代价**：库被读走 = 密钥泄露（备份、只读账号、日志转储同理）；补偿只有两条 —— 接口不回明文，日志与出参靠 `redact` 脱敏（设计 §5.5，`ai-agent-tool-engine.md:441-445`）。

**取用纪律**：

- 只经 `ctx.settings.secret(name)` 取明文（`tools.types.ts:148-149`）；页面与日志只给 `secretHint()`（`:150-151`）；
- 秘钥定义字段**一律可选、没有默认值**，缺了就是"未配置"（`tools.types.ts:300-303`）；必填秘钥缺失由 `precheck` 给 `precheck-failed` 结论并点名缺哪个（`plugins/precheck.plugin.ts:10-22`）。

**`redact` 插件覆盖什么 / 不覆盖什么**（`plugins/redact.plugin.ts:17-43`）：

| 覆盖 | 不覆盖 |
| --- | --- |
| `ok: true` 出参里出现的、**已在 `secretFields` 声明**的秘钥明文 → 换成提示串 | `ok: false` 的结论（拒绝 / 错误文案） |
| 在分页**之前**跑，所以给模型的第一页也不含明文 | 工具**入参**（`rawInput` 进时间线 `tool-call` 行，不脱敏） |
| — | 工具自己 `logger.info(...)` 打印的内容 |
| — | 自定义事件 payload（`ctx.emit` 的内容既不落库、也不脱敏） |
| — | 未在 `secretFields` 声明的任何字符串；子 agent 的 `system_prompt` / `task`（落 `runs.request_snapshot`） |

结论：**脱敏是最后一道网，不是"可以随便打印"的许可证**。写日志、出参、事件时都按"这段将来会被人看到"来写。

## 4. 命令执行边界

| 项 | 事实 | 依据 |
| --- | --- | --- |
| 身份 | **以服务进程的身份与权限执行**，能读写该身份能读写的一切 | `tools/bash.tool.ts:110-113` |
| 目录边界 | `resolve` + `path.relative` 判定（不是字符串前缀）：天然处理 `..` 逃逸与 Windows 大小写差异；越界**拒绝并说明**，不静默夹回 | `bash.tool.ts:304-321` |
| 两层开关 | env 硬开关（`AGENT_COMMAND_ENABLED`）+ 库开关（`ai_tools.enabled` / `config.enabled`），**都开才放行** | `plugins/enabled.plugin.ts:10-13`、`bash.tool.ts:286-302` |
| 时长 / 输出 | 模型传的时长只能更小；配置值既是默认值也是硬上限，且被 env 夹紧 | `bash.tool.ts:229-234,286-302` |
| 实时刷屏 | 逐行事件必须限流（行数上限 + 如实报省略量），并给部署侧硬上限；完整内容始终在出参 | 机制见 `docs/design/ai-agent-tool-engine.md` §5.17 |
| 纪律 | 有副作用的命令先问用户；只读公开请求不必先问；失败不原样重试 | `bash.tool.ts:198-210` |

**明确的代码里写着这不是沙箱**（类注释原话，`bash.tool.ts:110-113`；提示词 `partials/environment.eta:8-9` 也要求模型不要把环境描述当成沙箱）：没有文件系统隔离、没有网络策略、没有资源限制。当前工程只做四件事 —— 可开关、限默认目录（workdir）、限时长与输出、**每次调用完整入库**（时间线里的入参出参就是审计证据）。**真要强隔离，得把执行放进容器 / 沙箱**，那是另一件事，不在本工具里假装做到。

## 5. 不可信内容与注入

**风险面**：命令输出、外部抓取内容、用户与业务数据都可能进上下文；内容里写"请执行 X"时，模型可能当真。

| 现有防线 | 依据 |
| --- | --- |
| 权限关卡：即使模型被说动，越权调用仍被 `scope` 拒 | `plugins/scope.plugin.ts:13-53` |
| 破坏性动作的前置确认**纪律**写进工具描述（提示词层，非机制） | `bash.tool.ts:203-206` |
| 全量审计：每次调用的入参出参都落时间线，事后可复现模型看到什么 | `runtime/stream-recorder.ts:100-134` |
| 未知工具单独标 `unknown-tool` 状态，是"提示词与工具面不一致"的信号 | `stream-recorder.ts:146-172` |

**现状缺口（如实记录）**：AI 模块**没有专门的注入过滤层** —— 没有"把工具输出标记为不可信数据"的渲染隔离，也没有内容级检测。当前靠**提示词纪律 + 权限关卡 + 全量审计**三件事兜，属于**缓解**，不是消除。（`pnpm check:inject` 是 DI 装饰器守卫 `scripts/check-inject-decorators.ts`，与提示词注入无关，别混淆。）

工具作者的写作纪律：把工具出参当**数据**交给模型，不拼"请你现在调用 X"这类祈使句；外部内容保留来源与原文，不做"替我执行"的加工；模型侧也不因为内容里写了"请执行"就去执行。

## 6. 全量入库与审计

| 落什么 | 落在哪 | 依据 |
| --- | --- | --- |
| 工具入参（`tool-call` 行） | `timelines.payload.input`，**不裁剪** | `stream-recorder.ts:100-114` |
| 工具出参（`tool-result` 行） | `timelines.payload.output`，**不裁剪**（分页只改给模型的那一份） | `stream-recorder.ts:116-134`、`paginate.plugin.ts:9-14` |
| 审计旁证 | 合并进 `tool-result` 的 `payload.outcome`：`ok` / `reason` / `configVersion` / `durationMs` / `page` / `outputBytes` | `plugins/audit-end.plugin.ts:21-36`、`core/tools/tool.meta.ts` |
| 配置版本 | `configVersion` = 配置行 `updatedAt` ISO（无行时 `code-default`） | `audit-start.plugin.ts:9-12`、`tool.config.repository.ts:57`、`tool.settings.ts:86` |
| 系统指令全文 | 落一条 `system` 时间线快照，与送进模型的是**同一个字符串** | `core/envelope.ts:59-66` |
| 子 agent 动态提示词与任务 | 落 `runs.request_snapshot`（全量） | `runtime/agent-runner.ts:233-242` |
| 全轮消耗 | `runs.usage` + `timelines` 的 `step` 行（步级） | `database/entities/run-entity.ts:110-112`、`stream-recorder.ts:226-238` |

**目标**：事后能复现"**模型当时看到什么**（系统指令 + 上下文 + 工具出参）**、用的哪一版配置**（`configVersion`）、**谁调的**（`triggered_by` / `request_id`）"。

**硬规则**：

- `runs` / `timelines` **永不删除**（审计证据），只追加与更新终态（`run-entity.ts:12-13`、`timeline-entity.ts:11-14`）；时间线唯一的"改"是崩溃恢复重跑时的 upsert（`timeline-entity.ts:20-25`）；
- **不加物理外键**（全工程硬规则）：`conversation_id` / `run_id` / `parent_run_id` 只建索引、不建 FK（`run-entity.ts:45-52`、`docs/design/ai-agent.md:1448-1452`）；
- **事件是过程，出参是结论**：`data-tool-event` 只走流、不落库（`stream-recorder.ts:202-204`），刷新后还要看见的必须写进出参。

**现状缺口**：

- **AI 模块没有接 `telemetry` 统一入口**（模块内 grep 无匹配）：只有结构化日志（`ai.tool.invoked` / `ai.tool.denied` / `ai.command.executed`）与用量落库，**没有指标 / 分位 / 告警**。要补时看 `telemetry` skill；
- **谁归档 / 删除 / 停止 / 重试了，没有操作人**，只有软删标记 —— `docs/design/ai-agent.md:328`；
- 时间线**没有 hash 链防篡改**，靠"应用层只追加 + 部署只授 `INSERT` / `SELECT`"（`ai-agent.md:387,1975`）。

## 7. 删除与留存

| 数据 | 能删吗 | 口径 / 依据 |
| --- | --- | --- |
| 会话 `conversations` | **只能软删**（`deleted_at` / `deleted_by`） | `conversation-entity.ts:8`、`ai-agent.md:389-397` |
| `runs` / `timelines` | **永不删除**，没有删除入口 | `run-entity.ts:12-13`、`timeline-entity.ts:11-14`、`ai-agent.md:1974` |
| `ai_tools` 配置行 | 代码里删掉工具时**保留配置行**，只记 `last_seen_at`（历史 run 仍引用该 key） | `ai-tool-entity.ts:20-21,110-112` |
| 工具事件（`data-tool-event`） | 不落库，无留存问题 | `stream-recorder.ts:202-204` |
| 上下文摘要 | 摘要只是"给模型看的新起点"，**原文永不删除**（只追加） | `ai-agent.md:468` |

**软删前必须先结束在跑的运行**：会话有 `pending` / `running` 的 run 时，先走停止流程（`canceled`）再软删 —— 否则"用户看不到了、钱还在烧"（`ai-agent.md:395-396`）。会话 id 是 nanoid、不复用，软删后重开不会与旧数据混淆（`ai-agent.md:1307`）。

## 8. 自查清单

- [ ] **越权**：新工具在目标 agent 授权清单里？`scope` / `allowedAgents` / `child` / `delegation` 显式定过？拒绝给了 reason + hint（不是静默失败、不是 `internal`）？
- [ ] **身份链**：新调用路径经编排层注入信封？缺信封时是**拒绝**而非放行？子 agent 作用域仍按根 agent 判？
- [ ] **秘钥**：只经 `ctx.settings.secret()` 取？页面只回提示串？用到的秘钥字段在 `secretFields` 里声明（否则 `redact` 不生效）？工具自己的日志没打印明文？
- [ ] **脱敏边界**：知道 `redact` 不覆盖入参 / 事件 / 错误文案 / 自打日志 / 子 agent 提示词，并据此避免在这些位置放敏感值？
- [ ] **命令**：env + 库两层开关都在？`workDir` 用 `path.relative` 判边界？时长与输出有上限且被 env 夹紧？有副作用命令的"先问用户"纪律写在描述里？
- [ ] **不是沙箱**：文档与提示词里没有把命令执行说成隔离环境？
- [ ] **注入**：工具出参 / 命令输出 / 外部内容进上下文时按"数据非指令"处理？没有拼祈使句让模型执行内容里的动作？
- [ ] **审计**：入参出参全量落库（无裁剪）？`configVersion` 进了审计？`runs` / `timelines` 无删除入口、没加物理外键？
- [ ] **失败留痕**：超时 / 取消 / 非零退出 / 限流 / 拒绝各有结论文案，且留下可排查的结构化日志？
- [ ] **缺口登记**：本次引入的假想边界（如"靠提示词纪律兜住的注入风险"）写进设计文档，而不是当成已解决？
