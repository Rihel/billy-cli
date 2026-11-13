# AI 用量统计与告警设计（草案）

> 状态：日表 / 维度表与汇总链路已实现（2026-10-21）；**告警**后来按 `monitor-engine.md` 的
> 指标规则落地（`modules/ai/monitoring/`，见 §6）。本文保留原设计论证，**现状以 §11 补记为准**。
> 目标：把 AI 的**每日用量**沉淀成可查询、可回填、可告警的事实表，供控制台与告警模块共用。
> 非目标（本期不做）：按模型价格算钱、按用户/租户出账单、原始事件明细报表。

> **告警接入说明**：本文第 6 节的 `usage` 规则（新规则类型 + `scope_type` / `window_days` +
> `UsageAlertEvaluator`）是早期方案，**未采用**；最终实现是"AI 用量指标 + 指标规则"注册进监控引擎
> （见 [monitor-engine.md](./monitor-engine.md) 与本文 §11）。日表设计仍然有效。

## 1. 为什么要一张日表

现在的用量是"每次要看就现查 `runs` / `timelines`"：

- `runs` 有 token 与状态，但**没有按工具、按天、按模型的聚合**；
- `timelines` 有逐次工具调用与结果，但表很大，不适合控制台每次扫；
- 告警需要稳定的"水位"读模型，不能每 10 分钟对明细表做重聚合。

所以：**明细仍是 `runs` / `timelines`（审计事实），日表是派生统计**。
日表可以随时从明细重算（回填 / 修口径），不是第二份真相。

> 设计初期工作区里有一个直查 `runs` 的临时汇总；现已改成读日表（`AiUsageService.summary()`），
> **只保留一套口径**（`/agent/usage/summary` 返回的就是日表 + 维度表的聚合）。

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
| `stat_date` | `date` | 业务日（`YYYY-MM-DD`；**日界由 SQL 显式 `AT TIME ZONE 'Asia/Shanghai'` 切**，不依赖库的时区设置）；唯一 |
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

实体 / 迁移：`apps/server/src/database/entities/ai-usage-daily-entity.ts`、
`apps/server/src/database/migrations/1792600317837-AiUsageDaily.ts`。bigint 列在实体上挂了
transformer（读出转 `number`），避免 JSON 序列化成字符串。

### 3.2 维度表 `ai_usage_daily_dimension`（按模型 / agent / 工具分桶）

| 列 | 类型 | 说明 |
| --- | --- | --- |
| `stat_date` | `date` | 业务日 |
| `dimension_type` | `varchar(16)` | `model` / `agent` / `tool` |
| `dimension_key` | `varchar(128)` | `provider/model`、`assistant`、`bash`… |
| `conversations` / `runs` / `succeeded` / `failed` | int | 模型 / agent 维度用；工具维度为 0 |
| `total_tokens` / `input_tokens` / `output_tokens` | bigint | 模型 / agent 维度用 |
| `calls` / `tool_succeeded` / `tool_failed` / `tool_denied` / `tool_invalid` / `tool_unknown` / `tool_no_result` | int | 工具维度用 |
| `duration_ms` | bigint | 工具耗时（有 `payload.outcome.durationMs` 才计） |
| `metadata` | jsonb | 预留 |

唯一键：`uk_ai_usage_dimension (stat_date, dimension_type, dimension_key)`。
**没有单独的查询索引**（当初设想的 `(dimension_type, dimension_key, stat_date)` 没建）：
表很小（一天最多几十行），控制台按 `stat_date` 范围取全部维度行再在内存里分组，
`AiUsageService.summary()` 就是这么做的；真要做"某个工具的趋势"再补索引。

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

`modules/ai-usage/`（`AiUsageModule`），只依赖 `Db` + `RedisStore` + `Scheduler`，
不反向依赖 AI 业务模块；负责：

- `rollupDay(date)`：事务内 `DELETE` 当日两表数据 → 从 `runs` / `timelines` 重算 → `INSERT`
  （主表 1 行 + 维度表 model / agent / tool 各若干行）；
- `rollupRange(from, to)`：回填，逐日调用 `rollupDay`（上限 90 天，超了直接报错，避免一次扫太久）；
- 定时（`ai-usage.scheduler.ts`）：`Scheduler.scheduleCron('ai-usage-rollup', '*/10 * * * *', ...,
  { protect: true, timezone: 'Asia/Shanghai' })` 重算**今天 + 昨天**
  （昨天用于收尾跨午夜 / 晚到终态；今天给控制台一个不超过 10 分钟的最近值）；
  **启动时立刻跑一次**，避免控制台空等 10 分钟；
- 多实例：`RedisStore.acquireLock('ai-usage-rollup', 600)`，抢不到就跳过（releaseLock 在 finally）；
- 管理端补数：`POST /agent/usage/rollup { from, to }`（admin），返回 `{ days }`。

重算采用"先删后插"而不是增量累加：日表数据量很小，幂等、可修复，远比"漏一个事件就永久偏"安全。

SQL 在 `ai-usage.rollup.service.ts`（四条：`DAILY_SQL` / `MODEL_SQL` / `AGENT_SQL` / `TOOL_SQL`），
日界统一写 `(COALESCE(started_at, created_at) AT TIME ZONE 'Asia/Shanghai')::date = $1`。

## 6. 告警：复用 monitor，不另造一套

现有 `monitor` 已具备：规则 CRUD、事件 / 指标 / 突变三类规则、阈值、通道（file/lark/email）、
限频、`alert_logs` 审计、SSE 实时告警。**用量告警实际只新增了"数据源 + 指标 + 规则"三样，
没有新增规则类型**：

### 6.1 规则扩展（原方案的设想，**未采用**）

`alert_rules` 增加：

| 列 | 说明 |
| --- | --- |
| `type='usage'` | 第四种规则类型：读日表，不读进程内 Telemetry |
| `scope_type` | `total` / `model` / `agent` / `tool` |
| `scope_key` | 维度值（如 `bash`、`deepseek/deepseek-chat`）；`total` 为空 |
| `window_days` | 统计窗口：1 / 7 / 30（滚动，含今天） |

**实际情况**：没有 `type='usage'` 这种规则类型，也没有 `scope_type` / `scope_key` / `window_days`
三个列。用量告警走的是 `monitor-engine.md` 的**指标规则**：日表被包成一个指标源
（`modules/ai/monitoring/ai-usage.source.ts`），指标与规则定义是代码里的声明
（`ai-usage.metrics.ts` / `ai-usage.rules.ts`），注册进 `MonitorRegistry`。

### 6.1.1 实际实现的指标（`AI_USAGE_METRICS`）

| 指标 key | 含义 | 维度 |
| --- | --- | --- |
| `ai.usage.runs` / `succeeded` / `failed` / `canceled` / `interrupted` | 根 run 分桶 | model / agent |
| `ai.usage.tokens.total` / `.input` / `.output` / `.cacheRead` / `.cacheWrite` / `.reasoning` | token 分项 | model / agent |
| `ai.usage.steps` / `conversations` / `activeUsers` | 步数 / 活跃会话 / 活跃用户 | 无 |
| `ai.usage.tool.calls` / `.succeeded` / `.failed` / `.denied` / `.invalid` / `.unknown` / `.noResult` | 工具体分桶 | tool |
| `ai.usage.firstToken.sum` / `.count`、`ai.usage.duration.sum` | 首字延迟、轮耗时（原始和，比率在 derived 里算） | 无 |
| `ai.usage.failureRate` / `successRate` / `toolFailureRate` / `cacheHitRate` / `avgFirstTokenMs` / `avgDurationMs` / `tokensPerRun` | 派生指标 | 跟随依赖 |

注意与本文早期清单的差异：token 是 `ai.usage.tokens.total`（不是 `ai.usage.tokens`）、
工具调用是 `ai.usage.tool.calls`（不是 `ai.usage.toolCalls`）。

### 6.2 评估与去重（实际做法）

- 指标采集 / 规则评估由监控引擎统一跑：`evaluationIntervalSeconds: 300`、`windowSeconds: 86400`
  （即"当天"），`instanceMode: 'aggregate'` + `instanceAggregation: 'max'`；
- 去重与恢复交给监控引擎的通用机制：`silenceSeconds`（默认 1800）、`streakWindows`、
  `recoverAfterWindows`、`notifyOnRecovery`，**不是**本文早期设想的
  `ai:usage-alert:{ruleId}:{periodKey}` Redis 键；
- 触发后仍走 `Notifier` / `AlertLog` / `StreamHub`，与其它规则同一条投递链路。

### 6.3 内置规则（`AI_USAGE_RULES`，全部默认关闭）

| 规则 key | 指标 | 条件 | 级别 |
| --- | --- | --- | --- |
| `ai.usage.daily-tokens` | `ai.usage.tokens.total` | ≥ 1,000,000 | warn |
| `ai.usage.failure-rate` | `ai.usage.failureRate` | ≥ 0.10 | warn |
| `ai.usage.tool-failure-rate` | `ai.usage.toolFailureRate` | ≥ 0.20 | warn |
| `ai.usage.first-token` | `ai.usage.avgFirstTokenMs` | ≥ 8,000 | warn |

表单字段是 `threshold` / `silenceSeconds` / `level` / `channels` / `recoverAfterWindows`
（监控的通用指标规则表单），窗口固定 1 天，**没有**"7 天失败率""按工具的水位线"这类配置。

> 不建议自动塞一堆默认规则：水位跟部署、模型、业务量强相关，误报比不报更烦。
> 所以四条规则 `enabled: false`，由管理员在监控规则页显式启用。

## 7. 接口与控制台（现状）

接口**只有两个**（都在 `AiController`，`AdminAuthGuard`）：

- `POST /agent/usage/summary { days }`（1–90，默认 7）：读日表 + 维度表，返回
  `{ days, since, totals, daily, byModel, byAgent }`。`totals` 含 runs / 成功失败取消中断 /
  token 分项 / steps / toolCalls / avgDurationMs / avgFirstTokenMs；
  `daily` 只有 `{ date, runs, totalTokens, inputTokens, outputTokens }`；
  `byModel` / `byAgent` 是 `{ key, runs, totalTokens }` 的聚合桶。
- `POST /agent/usage/rollup { from, to }`：admin 补数 / 重算，返回 `{ days }`。

**没做的**：`POST /agent/usage/daily`（按天 + 维度的明细接口）不存在，`AiUsageService.day()`
只是监控指标源在用（按单个日期读日表 + 全部维度），没有 HTTP 出口。
SDK 侧是**平铺**的 `client.agent.usageSummary()` / `client.agent.usageRollup()`，
没有 `client.agent.usage.*` 命名空间。

控制台现状：

- **dashboard（`/main/dashboard`）的「AI 用量」区**：4 张指标卡（近 N 天对话 / tokens / 成功率 /
  平均首字延迟，可切 7 / 30 天）+ 每日 token 柱状图 + 「按模型」「按 Agent」两张占比表；
  数据全部来自 `usage/summary`。
- **`/main/ai/audit`（AI 会话审计）**：会话级列表（会话 / Agent / 状态 / 轮数 / 累计 token /
  最后活动），点开看每个 run 的状态、时延与 token；它读的是 `runs` / `timelines`，**不是日表**。
- **没做的**：每日用量明细表、按工具 Top-N、维度下钻趋势、告警阈值线。
- 告警规则不单独做表单：四条内置规则走监控规则页的**通用指标规则表单**（§6.3）。

## 8. 边界与坑

| 坑 | 处理 |
| --- | --- |
| 子 agent 重复计费 | token 只算根 run |
| 跨午夜 run | 按开始日归属，今天/昨天都重算 |
| 工具结果缺失 | 记 `no_result`，不算失败 |
| 供应商没上报 usage | 记 `usage_missing_runs`，不把空当 0 作为"正常" |
| 多实例重复汇总 | Redis 锁 `ai-usage-rollup`（TTL 600s），抢不到就跳过 |
| 多实例重复告警 | 交给监控引擎的 `silenceSeconds` / `streakWindows` / `recoverAfterWindows`（不是周期键） |
| 时区 | 日界由 SQL 显式 `AT TIME ZONE 'Asia/Shanghai'` 切（rollup 的 4 条 SQL 里共 6 处字面量），scheduler 另带 `timezone: 'Asia/Shanghai'`；换部署要一起改，**不依赖库时区** |
| 历史数据 | 首次上线补最近 30 天；更早按需回填 |
| 成本 | 没有单价表，先不显示金额，避免假数 |

## 9. 分期

1. **P1（已完成）**：两张日表 + 汇总任务 + 回填接口 + 控制台读日表（替换直查 runs 的临时汇总）。
2. **P2（以另一种方式完成）**：没有做 `usage` 规则类型，改为"AI 用量指标 + 4 条指标规则"注册进
   监控引擎（§6.1.1 / §6.3）；规则表单复用监控的通用指标规则表单，没有单独的"推荐水位模板"。
3. **P3（未做）**：按维度下钻页、P95、成本（需单价）、自动恢复通知。

## 10. 待确认（原始问题，已在实现中定案）

1. 表结构：**已定**——主表 + 维度表（理由见 §3.2）。
2. `window_days=1` 的语义：**已定**——取"当天"（`windowSeconds: 86400`，按 Asia/Shanghai 切日），
   中途就可以越线告警；没有"昨日终值"规则选项。
3. 按用户维度：**未做**（涉及隐私与权限）。
4. 水位：**已定**——四条内置规则各给一个保守默认阈值（§6.3），默认关闭，由管理员改。

## 11. 现状补记（2026-11-13）

- 代码位置：`apps/server/src/modules/ai-usage/`（`ai-usage.service.ts` 查询、`ai-usage.rollup.service.ts`
  SQL、`ai-usage.scheduler.ts` 定时）；实体 `ai-usage-daily-entity.ts` /
  `ai-usage-daily-dimension-entity.ts`；指标与规则 `apps/server/src/modules/ai/monitoring/`。
- 原始事件（逐轮）仍落在 `runs`（`usage` / `step_count` / `duration_ms` / `first_token_ms` /
  `error_stage`）与 `timelines`（`kind='tool-call'` / `tool-result`）；日表是**派生**，
  任何时候都能 `POST /agent/usage/rollup` 重算。
- 工具成败配对口径已实现：`output-available` / `output-error` / `denied` / `invalid` /
  `unknown-tool`，有调用无结果记 `tool_no_result`（不算失败）。
- 业务日归属用 `COALESCE(started_at, created_at)`；跨午夜的 run 算开始日。
- 控制台一次性口径：**dashboard 读日表**，**audit 页读 runs**，两者不是同一份数据源
  （audit 是"每一轮的事实"，日表是"汇总"）。
