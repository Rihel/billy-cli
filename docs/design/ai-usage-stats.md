# AI 用量统计与告警设计（草案）

> 状态：待评审（2026-10-21）
> 目标：把 AI 的**每日用量**沉淀成可查询、可回填、可告警的事实表，供控制台与告警模块共用。
> 非目标（本期不做）：按模型价格算钱、按用户/租户出账单、原始事件明细报表。

> **告警接入说明**：本文第 6 节的 `usage` 规则是早期方案；监控规则/引擎的最终设计见
> [monitor-engine.md](./monitor-engine.md)（规则文件化 + 引擎编排）。日表设计仍然有效。

## 1. 为什么要一张日表

现在的用量是"每次要看就现查 `runs` / `timelines`"：

- `runs` 有 token 与状态，但**没有按工具、按天、按模型的聚合**；
- `timelines` 有逐次工具调用与结果，但表很大，不适合控制台每次扫；
- 告警需要稳定的"水位"读模型，不能每 10 分钟对明细表做重聚合。

所以：**明细仍是 `runs` / `timelines`（审计事实），日表是派生统计**。
日表可以随时从明细重算（回填 / 修口径），不是第二份真相。

> 当前工作区里已有一个直查 `runs` 的临时汇总（`/agent/usage/summary` + 控制台区块），
> 设计确认后会把它改成读日表，**只保留一套口径**。

## 2. 指标清单（先做什么、还能加什么）

### 2.1 第一期必做

| 维度 | 指标 | 口径 / 来源 |
| --- | --- | --- |
| 对话 | 活跃会话数 | 当天有根 run 的 `conversation_id` 去重 |
|  | 新增会话数 | `conversations.created_at` 落在当天 |
|  | 活跃用户数 | 根 run 的 `triggered_by` 去重（匿名记 0，不参与） |
| 轮次 | 对话轮数 | 根 run 数（`parent_run_id IS NULL`） |
| 成败 | 成功 / 失败 / 取消 / 中断 | 根 run 按 `status` 分桶 |
|  | 成功率 | succeeded / runs（另给 failed 绝对值，避免"取消多"把成功率做低） |
| token | 总 / 输入 / 输出 | 根 run 的 `usage` 逐字段求和 |
|  | 缓存读 / 缓存写 / 推理 token | 同上（缺失记 null，聚合时按 0） |
|  | 缓存命中率 | cacheReadTokens / inputTokens |
| 模型 | 模型调用步数 | 根 run 的 `step_count` 求和 |
| 工具 | 工具调用总次数 | `timelines.kind='tool-call'` 计数（含子 agent 的工具） |
|  | 工具成功 / 失败 / 拒绝 / 入参非法 / 未知工具 / 无结果 | 与 `tool-result.state` 配对：`output-available` / `output-error` / `denied` / `invalid` / `unknown-tool`；有调用无结果 = `no_result` |
|  | 工具失败率 | failed / calls（拒绝、非法、未知单列，不混进"失败"） |
|  | 每个工具的调用次数与成败 | 按 `tool_key` 分桶 |
| 时延 | 轮均耗时 | 根 run 的 `duration_ms` 均值 |
|  | 平均首字延迟 | 根 run 的 `first_token_ms` 均值（有值的样本） |
| 覆盖度 | 无 usage 的轮数 | 根 run 有终态但 `usage` 为空，提醒"统计不是全量" |

### 2.2 第二期可加

- 按模型 / 按 agent 的 token、轮数、失败数、平均时延（本期维度表已留位）；
- 错误环节分布：model / tool / stream / timeout / recovery（`runs.error_stage`）；
- 工具耗时（工具结果 `payload.outcome.durationMs` 求和/均值）；
- P95 / P99 首字与轮耗时（需在汇总时算分位，或存直方图桶）；
- 上下文压缩次数与节省 token（`timelines.kind='summary'`）；
- 附件数（图片 / 文件分别计数）；
- 计划 / 子 agent 使用率（`plan-*` 与 `run-sub-agent` 工具计数）；
- 成本：需要先给模型加**输入/输出单价**，否则不编造金额。

## 3. 数据模型

### 3.1 主表 `ai_usage_daily`（一天一行）

| 列 | 类型 | 说明 |
| --- | --- | --- |
| `stat_date` | `date` | 业务日（按数据库时区，当前部署是 Asia/Shanghai）；唯一 |
| `conversations` | int | 活跃会话数 |
| `new_conversations` | int | 新增会话数 |
| `active_users` | int | 活跃用户数 |
| `runs` | int | 根 run 数 |
| `succeeded` / `failed` / `canceled` / `interrupted` | int | 根 run 状态分桶 |
| `total_tokens` / `input_tokens` / `output_tokens` | bigint | 根 run 的 usage 汇总 |
| `cache_read_tokens` / `cache_write_tokens` / `reasoning_tokens` | bigint | 同上 |
| `steps` | int | 模型调用步数 |
| `tool_calls` | int | 工具调用次数（含子 agent） |
| `tool_succeeded` / `tool_failed` / `tool_denied` / `tool_invalid` / `tool_unknown` / `tool_no_result` | int | 工具结果分桶 |
| `run_duration_ms` | bigint | 轮耗时总和（均值在读取时算） |
| `first_token_ms_sum` / `first_token_runs` | bigint / int | 首字延迟总和与样本数 |
| `usage_missing_runs` | int | 有终态但无 usage 的根 run 数 |
| `metadata` | jsonb | 预留：错误环节分布等非核心维度 |

索引：`uk_ai_usage_daily_date (stat_date)`，按日期查询直接命中。

### 3.2 维度表 `ai_usage_daily_dimension`（按模型 / agent / 工具分桶）

| 列 | 类型 | 说明 |
| --- | --- | --- |
| `stat_date` | `date` | 业务日 |
| `dimension_type` | `varchar(16)` | `model` / `agent` / `tool` |
| `dimension_key` | `varchar(128)` | `provider/model`、`assistant`、`run-command`… |
| `conversations` / `runs` / `succeeded` / `failed` | int | 模型 / agent 维度用；工具维度为 0 |
| `total_tokens` / `input_tokens` / `output_tokens` | bigint | 模型 / agent 维度用 |
| `calls` / `tool_succeeded` / `tool_failed` / `tool_denied` / `tool_invalid` / `tool_unknown` / `tool_no_result` | int | 工具维度用 |
| `duration_ms` | bigint | 工具耗时（有 `payload.outcome.durationMs` 才计） |
| `metadata` | jsonb | 预留 |

唯一键：`(stat_date, dimension_type, dimension_key)`；
查询索引：`(dimension_type, dimension_key, stat_date)`（看某个工具/模型的趋势）。

**为什么是两张表而不是一张大宽表**：主表回答"今天整体怎么样"，维度表回答"谁用的 / 哪个工具拖后腿"。
维度行天然稀疏（工具行没有 token，模型行没有工具成败），一张宽表会长期一半列是 0，
告警与 Top-N 查询也别扭。

## 4. 统计口径（容易踩的地方）

1. **token / 轮数 / 会话只算根 run**：子 agent 的 usage 收尾时已逐字段并进父 run，
   再按行加一遍就是**重复计费**。
2. **工具调用算所有 run**：子 agent 的工具也是真实执行，不存在"父包含子工具"的合并，
   所以按 `timelines` 全量算，不按根 run 的 `tool_call_count` 算。
3. **日期归属**：按 `COALESCE(started_at, created_at)` 落"开始那一天"。
   跨午夜的 run 算开始日；它最终 usage 变了，重算该日即可。
4. **工具成败配对**：`tool-call` 与 `tool-result` 通过 `(run_id, tool_call_id)` 配对；
   有调用无结果（崩溃 / 进程被杀）= `no_result`，**不算失败**，单独可见。
5. **模型归属**：`runs.request_snapshot->>'model'`（如 `deepseek/deepseek-chat`）；
   早期没有快照的记 `未记录`，不猜。
6. **空值**：`usage` 字段缺失按 0 参与求和，但另记 `usage_missing_runs`，避免把"没上报"当"零消耗"。
7. **取消 / 中断也计 token**：钱已经花了，不能因为状态不成功就不算用量。

## 5. 汇总任务（日表怎么来）

新增 `AiUsageModule`（或放在 `modules/ai-usage/`），只依赖 `Db` + `RedisStore` + `Scheduler`，
不反向依赖 AI 业务模块；负责：

- `rollupDay(date)`：事务内 `DELETE` 当日两表数据 → 从 `runs` / `timelines` 重算 → `INSERT`；
- `rollupRange(from, to)`：回填，逐日调用 `rollupDay`（上限 90 天，避免一次扫太久）；
- 定时：`Scheduler.scheduleCron('ai-usage-rollup', '*/10 * * * *', ...)` 重算**今天 + 昨天**
  （昨天用于收尾跨午夜 / 晚到终态；今天给控制台一个不超过 10 分钟的最近值）；
- 多实例：`RedisStore.acquireLock('ai-usage-rollup', ttl)`，抢不到就跳过；
- 管理端补数：`POST /agent/usage/rollup { from, to }`（admin）或脚本，用于新环境初始化。

重算采用"先删后插"而不是增量累加：日表数据量很小，幂等、可修复，远比"漏一个事件就永久偏"安全。

## 6. 告警：复用 monitor，不另造一套

现有 `monitor` 已具备：规则 CRUD、事件 / 指标 / 突变三类规则、阈值、通道（file/lark/email）、
限频、`alert_logs` 审计、SSE 实时告警。**用量告警只新增数据源与规则类型**：

### 6.1 规则扩展

`alert_rules` 增加：

| 列 | 说明 |
| --- | --- |
| `type='usage'` | 第四种规则类型：读日表，不读进程内 Telemetry |
| `scope_type` | `total` / `model` / `agent` / `tool` |
| `scope_key` | 维度值（如 `run-command`、`deepseek/deepseek-chat`）；`total` 为空 |
| `window_days` | 统计窗口：1 / 7 / 30（滚动，含今天） |

复用 `metric` / `operator` / `threshold_value` / `channels` / `throttle_seconds` / `enabled`。
`metric` 取值（第一版）：

- `ai.usage.conversations`
- `ai.usage.runs`
- `ai.usage.failed` / `ai.usage.failureRate`
- `ai.usage.tokens`
- `ai.usage.cacheHitRate`
- `ai.usage.toolCalls`
- `ai.usage.toolFailureRate`
- `ai.usage.avgFirstTokenMs`
- `ai.usage.avgDurationMs`

### 6.2 评估与去重

- `UsageAlertEvaluator` 每 10 分钟（与汇总同频）读日表，按 `scope_type` 汇总窗口内数据；
- 触发后走现有 `Notifier` / `AlertLog` / `StreamHub`，消息里带
  `指标 = 当前值（窗口起始~结束）`，例如：
  `AI 用量告警：近 1 天 tokens = 1,234,567 ≥ 1,000,000（2026-10-21）`；
- **每个规则每个周期只告警一次**：Redis 键 `ai:usage-alert:{ruleId}:{periodKey}`
  （`periodKey` 为当天日期；TTL = 窗口 + 1 天），多实例用锁互斥；
- 现有 `throttle_seconds` 对"内容变化"无效（值每次都在变），用量规则必须按周期去重，
  不能直接套事件规则的 content hash 限频。

### 6.3 建议水位（示例值，按部署调整）

| 规则 | metric | scope | window | 条件 | 级别 |
| --- | --- | --- | --- | --- | --- |
| 日 token 预警 | `ai.usage.tokens` | total | 1d | ≥ 1,000,000 | warn |
| 日 token 红线 | `ai.usage.tokens` | total | 1d | ≥ 5,000,000 | error |
| 日失败率 | `ai.usage.failureRate` | total | 1d | ≥ 0.10 | warn |
| 7 日失败率 | `ai.usage.failureRate` | total | 7d | ≥ 0.05 | error |
| 工具失败率 | `ai.usage.toolFailureRate` | total | 1d | ≥ 0.20 | warn |
| 单工具失败率 | `ai.usage.toolFailureRate` | tool `run-command` | 1d | ≥ 0.30 | warn |
| 首字延迟 | `ai.usage.avgFirstTokenMs` | total | 1d | ≥ 8,000 | warn |
| 日对话量 | `ai.usage.conversations` | total | 1d | ≥ 1,000 | warn |

> 不建议自动塞一堆默认规则：水位跟部署、模型、业务量强相关，误报比不报更烦。
> 后台提供「推荐规则」模板（填好指标/窗口/操作符，阈值可改），由管理员显式启用。

## 7. 接口与控制台

- `POST /agent/usage/summary { days }`：主表 totals + 每日数组 + Top 模型/agent/工具；控制台用。
- `POST /agent/usage/daily { from, to, dimension? }`（可选）：按天的明细表，供「用量明细」页。
- `POST /agent/usage/rollup { from, to }`：admin 补数/重算。
- SDK：`client.agent.usage.summary / daily / rollup`。
- 控制台：
  - 顶部指标卡：今日 / 近 7 天 tokens、对话轮数、成功率、首字延迟；
  - 每日柱状 + **每日用量明细表**（日期 / 会话 / 轮次 / 成功失败 / 输入输出 token / 工具失败率 / 平均延迟）；
  - 按模型 / 按 agent / 按工具 Top-N；点某个维度下钻到该维度的趋势；
  - 告警规则页新增 `usage` 类型表单：指标、作用域、窗口、操作符、阈值、通道，
    并显示"推荐水位"。
- 告警阈值线：控制台读启用的 usage 规则，在柱状图上画水位线（可选，第二期）。

## 8. 边界与坑

| 坑 | 处理 |
| --- | --- |
| 子 agent 重复计费 | token 只算根 run |
| 跨午夜 run | 按开始日归属，今天/昨天都重算 |
| 工具结果缺失 | 记 `no_result`，不算失败 |
| 供应商没上报 usage | 记 `usage_missing_runs`，不把空当 0 作为"正常" |
| 多实例重复汇总/重复告警 | Redis 锁 + 周期键去重 |
| 时区 | 业务日按数据库时区（当前 Asia/Shanghai）；换部署时显式统一 |
| 历史数据 | 首次上线补最近 30 天；更早按需回填 |
| 成本 | 没有单价表，先不显示金额，避免假数 |

## 9. 分期

1. **P1**：两张日表 + 汇总任务 + 回填接口 + 控制台读日表（替换现有直查 runs 的临时汇总）。
2. **P2**：`usage` 规则类型 + 评估器 + 周期去重 + 规则表单 + 推荐水位模板。
3. **P3**：按维度下钻页、P95、成本（需单价）、自动恢复通知。

## 10. 待确认

1. 表结构：主表 + 维度表（推荐），还是坚持一张宽表？
2. `window_days=1` 的语义：**今天到现在**（可中途告警）还是**昨天终值**（日报）？
   推荐：默认今天到现在，另给"昨日终值"规则选项。
3. 告警是否需要**按用户**维度（涉及隐私与权限，本期未做）。
4. 水位先按上面的示例，还是你直接给一组业务阈值？