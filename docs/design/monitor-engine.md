# 监控引擎设计（指标 / 规则 / 评估 / 通知 / 落库）

> 状态：待评审（2026-10-21）
> 目标：把「指标采集、规则评估、告警通知、指标落库」从散在 `AlertTrigger` 里的两条硬编码链路，
> 重构成一个由代码定义、由引擎编排的监控体系；覆盖系统告警与业务告警（AI 用量等）。
> 本文与 `ai-usage-stats.md` 的关系：用量日表的设计保留；**告警接入方式以本文为准**。

## 1. 设计原则

1. **指标与规则是代码资产**：一个指标一个文件、一条规则一个文件，放进仓库、走 code review；
2. **配置是数据**：阈值、窗口、通道、开关等放数据库，后台可改，改完下一次评估生效；
3. **引擎只做编排**：取数 → 落库 → 评估 → 去重 → 通知，不把业务判断写进引擎；
4. **启动即对账**：每次启动把代码里的规则 upsert 进库，**保证规则记录存在**，不靠人工初始化；
5. **系统与业务同一套引擎**：系统指标（HTTP / 进程）和业务指标（AI 用量）只是不同的
   `MetricDefinition` / `RuleDefinition`，评估、通知、审计完全复用。

## 2. 现状与问题（为什么重构）

当前 `AlertTrigger`：

- 事件规则、指标规则、限频、通知、落库全在一个类里；
- 规则类型写死 `tech/business/metric/surge`，指标值写死在 `buildMetricValues()`；
- 指标只来自进程内 `Telemetry` 60s 窗口，没有落库、没有历史；
- 规则是后台手工建的，代码里没有"这条规则应该存在"的声明，换环境要手工配；
- 多实例各自评估、状态在内存，重启丢失。

新设计要解决：**规则可声明、指标可扩展、历史可回看、启动可对账**。

## 3. 总体架构

```
                    ┌────────────────────────────┐
业务模块（AI / 订单…）│  metrics/*.metric.ts        │
                    │  rules/*.rule.ts            │
                    └─────────────┬──────────────┘
                                  │ 注册（Nest multi-provider）
                    ┌─────────────▼──────────────┐
                    │ MonitorEngine              │
                    │ ① 按窗口采集指标            │
                    │ ② 指标样本落库              │
                    │ ③ 读规则 + 取最近样本        │
                    │ ④ 评估 / 阈值 / 环比         │
                    │ ⑤ 周期去重                  │
                    │ ⑥ 通知 / 审计 / SSE         │
                    └──────┬──────────┬──────────┘
                           │          │
                 MetricSamples    AlertRule / State
                 （时间序列）      （配置 / 去重）
                           │          │
                    ┌──────▼──────────▼──────┐
                    │ Notifier（file/lark/email）│
                    │ AlertLog + StreamHub      │
                    └───────────────────────────┘
```

引擎本身不 import 任何业务模块；业务模块通过 `MONITOR_METRICS` / `MONITOR_RULES` 注入定义。

## 4. 目录结构

```
apps/server/src/modules/monitor/
├── definitions/
│   ├── metric.types.ts          # MetricDefinition / MetricSample / 采集上下文
│   ├── rule.types.ts            # RuleDefinition / RuleConfig / 评估结果
│   └── define.ts                # defineMetric / defineRule 辅助
├── engine/
│   ├── monitor.engine.ts        # 编排：tick / ingestError / 通知
│   ├── metric.registry.ts       # 注册表 + 启动期校验
│   ├── rule.registry.ts
│   ├── metric-sample.repository.ts
│   ├── rule-state.repository.ts
│   └── seed.service.ts          # 启动对账（upsert 规则）
├── metrics/system/              # 一个指标一个文件
│   ├── raw/                     # 原始指标（直接取数）
│   │   ├── http-count.metric.ts
│   │   ├── http-error.metric.ts
│   │   ├── http-duration.metric.ts
│   │   └── process-memory.metric.ts
│   └── derived/                 # 衍生指标（纯计算）
│       ├── http-error-rate.metric.ts
│       ├── http-qps.metric.ts
│       ├── http-p99.metric.ts
│       └── process-memory-ratio.metric.ts
├── rules/system/                # 一条规则一个文件
│   ├── http-error-rate.rule.ts
│   ├── http-p99.rule.ts
│   ├── process-memory.rule.ts
│   ├── uncaught-exception.rule.ts
│   └── index.ts
├── api/                         # 规则配置 / 指标查询 / 引擎状态
└── monitor.module.ts

apps/server/src/modules/ai/monitoring/
├── metrics/raw/ai-daily-counts.metric.ts
├── metrics/raw/ai-daily-tokens.metric.ts
├── metrics/derived/ai-failure-rate.metric.ts
├── metrics/derived/ai-tool-failure-rate.metric.ts
├── rules/ai-daily-tokens.rule.ts
├── rules/ai-failure-rate.rule.ts
├── rules/ai-tool-failure-rate.rule.ts
└── index.ts
```

> AI 的 metrics / rules 放 `modules/ai/monitoring/`，由 `AiUsageModule` 导出、`MonitorModule` 注入；
> monitor 核心不依赖 AI。以后订单、支付等业务照此新增自己的 `monitoring/` 目录。

### 4.1 注册方式

- 每个业务模块导出 `MONITOR_METRICS` / `MONITOR_RULES` 两个数组（Nest multi-provider）；
- `MonitorModule` 汇总系统定义 + 注入各业务模块导出的定义；
- `MetricRegistry` / `RuleRegistry` 在启动期校验：key 唯一、rule.metricKey 存在、
  默认配置能通过定义校验；失败**启动即报错**，不让坏规则进运行期；
- 不引入目录扫描 / 装饰器魔法：每个 `index.ts` 显式 import 自己的文件，
  和现有 agent / 工具注册保持一致。

## 5. 指标定义与分层（一个指标一个文件）

指标分两类，**原始指标负责取数，衍生指标负责口径**。规则可以引用两类指标，但优先引用衍生指标
（阈值语义稳定；原始指标留给"累计量"类规则，如日 token）。

### 5.1 原始指标（Raw）

- 从数据源**直接取到的计数 / 求和 / 当前值**，不做比率、不做平均；
- 一个指标一个文件，声明采集窗口与采集间隔；
- 会落库，是衍生指标的唯一输入；
- 口径变化只改衍生指标，不用重新采集。

| 原始指标 | 含义 | 来源 |
| --- | --- | --- |
| `request.count` | 窗口内请求数（**计数，不是 QPS**） | 请求中间件 → Telemetry |
| `request.error` | 窗口内 5xx 请求数 | 请求中间件 → Telemetry |
| `request.duration.sum` / `request.duration.count` | 耗时总和 / 样本数（ms） | 请求中间件直方图 |
| `request.duration.bucket` | 直方图各桶计数（维度 `le`） | 请求中间件直方图 |
| `process.memory.used` / `process.memory.total` | 堆已用 / 堆总量（bytes） | `process.memoryUsage()` |
| `ai.usage.runs` | 根 run 数 | AI 日表 |
| `ai.usage.succeeded` / `failed` / `canceled` / `interrupted` | 根 run 状态计数 | AI 日表 |
| `ai.usage.tokens.input` / `output` / `total` / `cacheRead` / `cacheWrite` / `reasoning` | token 计数 | AI 日表 |
| `ai.usage.steps` | 模型调用步数 | AI 日表 |
| `ai.usage.conversations` / `activeUsers` | 活跃会话 / 用户 | AI 日表 |
| `ai.usage.tool.calls` / `succeeded` / `failed` / `denied` / `invalid` / `unknown` / `noResult` | 工具调用与结果计数 | AI 日表 |
| `ai.usage.firstToken.sum` / `firstToken.count` | 首字延迟总和 / 样本数 | AI 日表 |
| `ai.usage.duration.sum` | 轮耗时总和 | AI 日表 |

> **原始指标不存比率**：`request.count` 就是"60 秒内 200 次"，不是 3.3 QPS；
> QPS、错误率、缓存命中率都由衍生指标算。这样换窗口 / 换聚合不会把口径混在一起。

### 5.2 衍生指标（Derived）

- 不单独采集，**由引擎从同一窗口、同一维度的原始样本计算**；
- 声明 `dependsOn`（原始指标 key），引擎保证依赖先采、先落库；
- 也落库（历史趋势、规则、控制台都用它）；
- 只做纯计算，不查库、不读 Telemetry / AI 日表。

| 衍生指标 | 公式 | 依赖 |
| --- | --- | --- |
| `request.errorRate` | `request.error / request.count` | error / count |
| `request.qps` | `request.count / windowSeconds` | count |
| `request.avgDuration` | `request.duration.sum / request.duration.count` | duration sum / count |
| `request.p95` / `request.p99` | 直方图桶累计分位（近似上边界） | duration.bucket |
| `process.memory` | `process.memory.used / process.memory.total` | used / total |
| `ai.usage.failureRate` | `ai.usage.failed / ai.usage.runs` | failed / runs |
| `ai.usage.successRate` | `ai.usage.succeeded / ai.usage.runs` | succeeded / runs |
| `ai.usage.toolFailureRate` | `ai.usage.tool.failed / ai.usage.tool.calls` | tool failed / calls |
| `ai.usage.cacheHitRate` | `cacheRead / input` | cacheRead / input |
| `ai.usage.avgFirstTokenMs` | `firstToken.sum / firstToken.count` | sum / count |
| `ai.usage.avgDurationMs` | `duration.sum / runs` | duration / runs |
| `ai.usage.tokensPerRun` | `tokens.total / runs` | total / runs |

### 5.3 定义结构

```ts
export interface MetricSample {
  metricKey: string
  /** raw / derived：落库时带上，方便查询与排障；定义里也有 */
  kind: 'raw' | 'derived'
  value: number
  /** 窗口标识：60s 指标用窗口开始时间；按天指标用 YYYY-MM-DD */
  windowKey: string
  windowStart: Date
  windowEnd: Date
  instanceId?: string
  /** 维度：total / model / agent / tool / code / le … */
  dimensionType?: string
  dimensionKey?: string
  labels?: Record<string, string>
}

interface MetricDefinitionBase {
  key: string
  title: string
  description: string
  category: 'system' | 'business'
  unit: 'ratio' | 'ms' | 'count' | 'tokens' | 'bytes'
  windowSeconds: number
}

/** 原始指标：直接取数 */
export interface RawMetricDefinition extends MetricDefinitionBase {
  kind: 'raw'
  /** 采集间隔（必须是引擎 tick 的整数倍） */
  collectIntervalSeconds: number
  /** instance：每个副本都采；global：只由 leader 采（业务日表类） */
  scope: 'instance' | 'global'
  collect(ctx: MetricCollectContext): Promise<MetricSample[]> | MetricSample[]
}

/** 衍生指标：从原始样本算 */
export interface DerivedMetricDefinition extends MetricDefinitionBase {
  kind: 'derived'
  /** 只能依赖原始指标；第一版不允许多级派生（避免循环与口径套娃） */
  dependsOn: readonly string[]
  derive(ctx: DeriveContext): Promise<MetricSample[]> | MetricSample[]
}

export interface MetricCollectContext {
  now: Date
  instanceId: string
  telemetry: Telemetry
  cache: Map<string, unknown>
  deps: Record<string, unknown>
}

export interface DeriveContext {
  window: { key: string; start: Date; end: Date }
  instanceId?: string
  dimensionType?: string
  dimensionKey?: string
  /** 同一窗口 / 同一维度下某个原始指标的全部样本 */
  raw(metricKey: string): MetricSample[]
}
```

### 5.4 示例

原始指标：

```ts
export const httpRequestCount = defineRawMetric({
  key: 'request.count',
  title: 'HTTP 请求数',
  description: '60 秒窗口内完成的请求数（计数，不是 QPS）',
  category: 'system',
  unit: 'count',
  windowSeconds: 60,
  collectIntervalSeconds: 60,
  scope: 'instance',
  collect: ({ telemetry, instanceId }) => {
    const snapshot = telemetry.snapshot()
    return {
      metricKey: 'request.count',
      kind: 'raw',
      value: snapshot.counters['request.count'] ?? 0,
      windowKey: new Date(snapshot.windowStartAt).toISOString(),
      windowStart: new Date(snapshot.windowStartAt),
      windowEnd: new Date(),
      instanceId,
    }
  },
})
```

衍生指标：

```ts
export const httpErrorRate = defineDerivedMetric({
  key: 'request.errorRate',
  title: 'HTTP 错误率',
  description: '同一 60 秒窗口内 5xx 请求数 / 请求数',
  category: 'system',
  unit: 'ratio',
  windowSeconds: 60,
  dependsOn: ['request.error', 'request.count'],
  derive: ({ raw, instanceId, window }) => {
    const total = raw('request.count')[0]?.value ?? 0
    const errors = raw('request.error')[0]?.value ?? 0
    return {
      metricKey: 'request.errorRate',
      kind: 'derived',
      value: total > 0 ? errors / total : 0,
      windowKey: window.key,
      windowStart: window.start,
      windowEnd: window.end,
      instanceId,
    }
  },
})
```

AI 原始 + 衍生：

```ts
// raw：从 AI 日表取当天的计数
export const aiDailyRuns = defineRawMetric({ key: 'ai.usage.runs', ... })

// derived：失败率
export const aiFailureRate = defineDerivedMetric({
  key: 'ai.usage.failureRate',
  windowSeconds: 86_400,
  dependsOn: ['ai.usage.failed', 'ai.usage.runs'],
  derive: ({ raw, window }) => {
    const runs = raw('ai.usage.runs')[0]?.value ?? 0
    const failed = raw('ai.usage.failed')[0]?.value ?? 0
    return {
      metricKey: 'ai.usage.failureRate',
      kind: 'derived',
      value: runs > 0 ? failed / runs : 0,
      windowKey: window.key,
      windowStart: window.start,
      windowEnd: window.end,
      dimensionType: 'total',
      dimensionKey: '',
    }
  },
})
```

### 5.5 计算顺序与约束

```
采集 raw → 落库 raw → 计算 derived → 落库 derived → 评估规则
```

- 启动校验：`dependsOn` 必须存在且都是 raw（第一版）；`derived` 不许自己采集；
- 按 `windowKey + instanceId + dimensionType + dimensionKey` 对齐依赖样本，缺依赖就跳过（**不拿 0 硬算**）；
- 同一个 raw 窗口被更新（例如 AI 当天 token 涨了），对应 derived 重算并 upsert；
- 规则可引用 raw 或 derived；引用 derived 时阈值语义稳定，推荐；
- 原始指标改名 / 删除，依赖它的 derived 启动报错，不会静默失效。

### 5.6 采集窗口

| 指标 | 类型 | 窗口 | 采集间隔 | scope |
| --- | --- | --- | --- | --- |
| `request.*` 原始计数 | raw | 60s（Telemetry 现有窗口） | 60s | instance |
| `request.*` 衍生比率 / 分位 | derived | 60s | 跟随依赖 | — |
| `process.memory.*` | raw / derived | 采集时点 / 60s | 60s | instance |
| `ai.usage.*` 原始计数 | raw | 1 天（滚动当日） | 300s | global |
| `ai.usage.*` 衍生比率 | derived | 1 天 | 跟随依赖 | — |

- 引擎 tick 固定 10s；raw 指标按 `collectIntervalSeconds` 到期采集；
- 样本按 `(metricKey, windowKey, instanceId, dimensionType, dimensionKey)` upsert；
- 系统指标按实例采集；AI 日指标是全局事实，只由 leader 采集；
- derived 不单独调度：依赖 raw 有更新就重算。

## 6. 规则定义（一条规则一个文件）

```ts
export interface RuleDefinition {
  /** 稳定 code key，用来 seed / 对账 / 关联代码，如 system.http.error-rate */
  key: string
  name: string
  description: string
  category: 'system' | 'business'
  kind: 'event' | 'metric'
  /** metric 规则必填 */
  metricKey?: string
  /** 取最近多少个样本（默认 1）；按天规则 7 天就填 7 */
  lookback?: number
  /** 多实例样本聚合：per-instance 逐实例评估；aggregate 先聚合 */
  instanceMode?: 'per-instance' | 'aggregate'
  aggregation?: 'last' | 'sum' | 'avg' | 'max'
  /** 默认配置（写库的初始值；之后以库里为准） */
  defaults: RuleConfig
  /** 后台可编辑字段（通用字段 + 规则自定义字段） */
  fields: RuleConfigField[]
  /** 自定义评估；不写则用 operator + threshold 通用比较 */
  evaluate?: (input: RuleEvaluateInput) => RuleDecision
}

export interface RuleConfig {
  enabled: boolean
  operator: 'gt' | 'gte' | 'lt' | 'lte'
  threshold: number
  channels: ('file' | 'lark' | 'email')[]
  throttleSeconds: number
  level: 'warn' | 'error'
  /** event 规则专用 */
  matchCodes?: number[]
  keywords?: string[]
  /** 规则自定义参数（字段由 fields 描述） */
  [key: string]: unknown
}
```

示例（系统指标规则）：

```ts
export const httpErrorRateRule = defineRule({
  key: 'system.http.error-rate',
  name: 'HTTP 错误率过高',
  description: '60 秒窗口内 5xx 占比超过阈值',
  category: 'system',
  kind: 'metric',
  metricKey: 'request.errorRate',
  instanceMode: 'per-instance',
  aggregation: 'last',
  defaults: {
    enabled: true,
    operator: 'gt',
    threshold: 0.05,
    channels: ['file'],
    throttleSeconds: 300,
    level: 'error',
  },
  fields: [
    { key: 'threshold', label: '错误率阈值', type: 'number', min: 0, max: 1, step: 0.01 },
    { key: 'throttleSeconds', label: '限频（秒）', type: 'number', min: 0 },
  ],
})
```

示例（AI 日规则）：

```ts
export const aiDailyTokensRule = defineRule({
  key: 'ai.usage.daily-tokens',
  name: 'AI 日 token 水位',
  description: '当天累计 token 超过水位时告警',
  category: 'business',
  kind: 'metric',
  metricKey: 'ai.usage.tokens',
  lookback: 1,
  instanceMode: 'aggregate',
  aggregation: 'sum',
  defaults: {
    enabled: true,
    operator: 'gte',
    threshold: 1_000_000,
    channels: ['file'],
    throttleSeconds: 86_400,
    level: 'warn',
  },
  fields: [
    { key: 'threshold', label: 'token 水位', type: 'number', min: 0 },
  ],
})
```

### 6.1 规则清单（第一期）

| rule key | kind | metric | 默认窗口 / 聚合 | 默认水位 | 级别 |
| --- | --- | --- | --- | --- | --- |
| `system.http.error-rate` | metric | `request.errorRate` | 60s / 最新 | > 0.05 | error |
| `system.http.p99` | metric | `request.p99` | 60s / 最新 | > 1000ms | warn |
| `system.process.memory` | metric | `process.memory` | 60s / 最新 | > 0.85 | warn |
| `system.error.uncaught` | event | — | 60s 次数 | ≥ 1 | error |
| `ai.usage.daily-tokens` | metric | `ai.usage.tokens.total` | 1d / sum | ≥ 1,000,000 | warn |
| `ai.usage.failure-rate` | metric | `ai.usage.failureRate` | 1d / last | ≥ 0.10 | warn |
| `ai.usage.tool-failure-rate` | metric | `ai.usage.toolFailureRate` | 1d / last | ≥ 0.20 | warn |
| `ai.usage.first-token` | metric | `ai.usage.avgFirstTokenMs` | 1d / last | ≥ 8000ms | warn |

> 具体水位是**默认值**，后台可改；每个部署的模型、流量、业务量不同，不追求全局最优。

## 7. 监控引擎

### 7.1 tick 编排

```
每 10s：
  ① 抢 leader 锁（Redis，TTL 30s；只影响 global 采集与规则评估）
  ② 对本实例到期 raw metric：collect → 批量 upsert monitor_metric_samples
  ③ leader：对 global raw metric：collect → upsert
  ④ 依赖 raw 有更新的 derived metric：重算 → upsert
  ⑤ leader：加载启用规则（code 定义 + 库配置）
  ⑥ 对每条规则：按 metricKey / lookback / instanceMode 取样本 → 聚合 → evaluate
  ⑦ 命中且未在本周期告警过 → Notifier → AlertLog → StreamHub → 写 rule_state
  ⑧ 每 10 分钟清理过期样本（按保留期）
```

### 7.2 事件规则

- `AppExceptionFilter` / 进程级异常改为调 `MonitorEngine.ingestError(error, context)`；
- 引擎按启用的事件规则匹配 `matchCodes` / `keywords`；
- 次数窗口用 Redis（`monitor:event:<ruleKey>:<hash>`，TTL = 窗口），多实例共享；
- 达到阈值后走同一套通知 / 落库 / 去重；
- 默认规则由代码定义，启动 seed；不再依赖"手工建规则"。

### 7.3 去重（每规则每周期一次）

- 新增 `monitor_rule_states`：`(rule_id, instance_id, state_key)` 唯一；
- `state_key`：60s 指标用窗口开始时间；按天指标用日期；事件规则用窗口 bucket；
- 告警成功后 `INSERT ... ON CONFLICT DO NOTHING`；已存在则跳过；
- 与 Redis lock 配合，保证多实例同一周期只发一次；
- 状态落库而不是只放内存，重启不会重复发。

### 7.4 通知

- 复用现有 `Notifier`（file / lark / email）、`AlertLog`、`StreamHub`；
- 告警正文包含：规则名 / 指标 / 当前值 / 窗口 / 维度 / 实例；
- 通道未配置时 `Notifier` 返回 `{ ok:false }`，照常落库（失败可查），不阻塞其它通道；
- `testNotify` 保留，手工验证通道。

## 8. 数据模型

### 8.1 `monitor_metric_samples`

| 列 | 类型 | 说明 |
| --- | --- | --- |
| `metric_kind` | varchar(8) | `raw` / `derived`（冗余，便于查询与排障） |
| `metric_key` | varchar(100) | 指标 key |
| `window_key` | varchar(64) | 窗口标识（60s 用 ISO 时间；按天用 YYYY-MM-DD） |
| `window_start` / `window_end` | timestamptz | 窗口起止 |
| `instance_id` | varchar(64) | 实例；global 指标写空串 |
| `dimension_type` | varchar(16) | total / model / agent / tool / code |
| `dimension_key` | varchar(128) | 维度值，total 为空串 |
| `value` | numeric(20,4) | 指标值 |
| `labels` | jsonb | 其它标签（错误码、工具名等） |
| `created_at` | timestamptz | 采集时间 |

唯一键：`(metric_key, window_key, instance_id, dimension_type, dimension_key)`；
索引：`(metric_key, window_end DESC)`、`(dimension_type, dimension_key, window_end DESC)`。
保留期：默认 30 天（`MONITOR_SAMPLE_RETENTION_DAYS`）。

### 8.2 `alert_rules` 扩展

新增：

| 列 | 说明 |
| --- | --- |
| `rule_key` | 代码里的稳定 key，唯一（manual 旧规则为空） |
| `kind` | `event` / `metric` |
| `category` | `system` / `business` |
| `metric_key` | 指标 key（event 规则为空） |
| `source` | `code` / `manual` |
| `config` | jsonb，规则配置（阈值、窗口、通道、开关、自定义字段） |
| `definition_version` | 代码定义版本，用于提示"定义已更新" |
| `deprecated` | 代码里已删除的规则置 true + enabled=false，保留历史 |

旧列（`type` / `matchCodes` / `keywords` / `threshold` / `metric` / `operator` / `thresholdValue` /
`periodSeconds`）保留用于迁移，但**新引擎只读 `config`**；旧手工规则迁移后置 `source='manual'`、
`enabled=false`，避免和代码规则双重告警。

### 8.3 `monitor_rule_states`

`(rule_id, instance_id, state_key)` 唯一；`fired_at`、`value`、`payload jsonb`。
用于周期去重与"上次触发值"展示。

### 8.4 AI 用量日表

沿用 `ai-usage-stats.md` 的 `ai_usage_daily` / `ai_usage_daily_dimension`；
AI 指标文件读它，再产出 `monitor_metric_samples`。日表是业务口径，样本表是引擎时间序列，
两者职责不同，不互相替代。

## 9. 启动对账（确保有规则记录）

`MonitorSeedService.onApplicationBootstrap()`：

1. 取代码里注册的全部 `RuleDefinition`；
2. 校验：key 唯一、metric 存在、默认配置能通过定义校验、字段 key 不重复；
3. 对每个定义按 `rule_key` upsert：
   - 不存在 → 插入（`source='code'`，`config=defaults`）；
   - 已存在 → **只更新元数据**（name / description / category / metricKey / definitionVersion），
     **不覆盖** `config` / `enabled`；
4. 库中存在但代码里已没有的 `source='code'` 规则 → `enabled=false` + `deprecated=true`
   （保留历史，不删）；
5. 启动日志打印：新增 / 更新 / 已停用数量；校验失败直接启动失败。

这样任何环境（新库、旧库、测试库）启动后都**至少有代码里声明的规则记录**；
后台页面看到的就是这些规则，可直接改阈值。

## 10. 系统与业务告警覆盖

### 系统

- HTTP 错误率、QPS、P99、平均耗时；
- 进程内存；
- 未捕获异常 / 未处理 Promise（事件规则）；
- 后续可加 DB / Redis 健康、Kafka 堆积等指标（各加一个 metric 文件 + 规则文件）。

### 业务（AI）

- 日 token 水位、日轮数、失败率、工具失败率、首字延迟、会话量；
- 按模型 / agent / 工具维度（来自 `ai_usage_daily_dimension`）；
- 后续业务照此模式：`modules/<业务>/monitoring/metrics|rules`，注册即可。

## 11. API 与界面

| 接口 | 说明 |
| --- | --- |
| `POST /monitor/rule/definitions` | 代码定义元数据（名称、描述、字段、默认值） |
| `POST /monitor/rule/list` | 规则列表：定义 + 库配置 + 最近状态 |
| `POST /monitor/rule/update` | 只改 `config` / `enabled`（不能再新建代码规则） |
| `POST /monitor/rule/reset` | 恢复代码默认配置 |
| `POST /monitor/metric/series` | 指标历史（key / 维度 / 时间范围） |
| `POST /monitor/metric/latest` | 最新值（控制台卡片） |
| `POST /monitor/engine/status` | 上次 tick、各指标采集时间、规则评估时间 |
| `POST /monitor/log/page-query` | 告警记录（沿用） |
| `POST /monitor/test` | 测试通知（沿用） |

界面：

- 规则页改为"代码规则清单"：按 system / business 分组，显示文件路径、指标、当前配置；
  只提供编辑配置 / 启停 / 恢复默认，不提供"新建规则"；
- 指标页：分「原始指标 / 衍生指标」两组，衍生指标显示公式与依赖；按指标看最近值、趋势、命中规则；
- 引擎状态：最近 tick、每个指标上次采集时间、规则上次评估 / 触发时间；
- 控制台 AI 用量卡片读 `ai_usage_daily` 或 `monitor_metric_samples`（二选一，避免两套口径）。

## 12. 多实例

- 每个实例有 `instanceId`（`MONITOR_INSTANCE_ID`，缺省 hostname / 启动 nanoid）；
- `scope='instance'` 的指标每个副本都采，样本带实例；规则 `per-instance` 逐实例评估、
  状态 key 带实例；
- `scope='global'` 的指标和规则评估由 leader 执行，Redis 锁抢主；
- 事件计数用 Redis，多实例共享；
- 告警状态落 `monitor_rule_states`，重启 / 换主不重复。

## 13. 迁移与分期

**P0 表结构**

- 新增 `monitor_metric_samples`、`monitor_rule_states`；
- `alert_rules` 加 `rule_key` / `kind` / `category` / `metric_key` / `source` / `config` / `definition_version`；
- 旧规则迁移为 `source='manual'`、`enabled=false`。

**P1 引擎 + 系统告警**

- 原始 / 衍生指标类型、注册表与依赖校验；
- `MonitorEngine` tick + 落库 + 派生 + 评估 + 去重；
- 系统 metrics / rules 文件 + seed；
- 异常钩子改接 `ingestError`；
- 规则页改成"代码规则 + 配置"。

**P2 AI 用量**

- `ai_usage_daily` 汇总任务（见 `ai-usage-stats.md`）；
- AI metrics / rules 文件；
- 控制台 AI 用量 + 告警水位。

**P3 增强**

- 指标趋势页 / 下钻；
- 样本保留期与归档；
- 多实例聚合模式、P95/P99 业务指标；
- 成本（需模型单价）。

## 14. 测试

- 注册表：重复 key / 缺 metric / 默认配置非法 / derived 依赖不存在或依赖 derived → 启动失败；
- seed：新库插入、旧库保留用户配置、代码删除规则置 deprecated、重复启动幂等；
- 引擎：fake raw / derived metric / fake rule，验证采数、派生、落库、阈值、去重、重启不重复；
- 派生：同窗口同维度对齐、缺依赖跳过、raw 更新后 derived upsert、p95 分位计算；
- 事件：code/keyword 匹配、Redis 计数窗口、阈值；
- 通知：通道失败落 `failed`、SSE 负载、通知异常不阻断；
- 多实例：锁竞争只有一个 leader 评估 / global 采集；
- 业务：AI 日表数据 → 指标样本 → token 水位规则触发；
- 迁移：旧规则不被新引擎重复执行。

## 15. 待确认

1. **旧手工规则**：迁移后统一停用、只保留代码规则（推荐），还是保留一个"manual"扩展口？
2. **系统指标多实例**：默认逐实例告警（推荐，单机部署无感），还是先只支持单实例？
3. **样本保留期**：默认 30 天是否合适？
4. **评估频率**：引擎 tick 10s、系统指标 60s、AI 指标 300s 是否合适？
5. **默认水位**：第 6.1 节的默认值是否按你们实际模型 / 流量调整？
6. **事件规则**：未捕获异常外，是否还要默认对某类 `AppError`（如 5xx）建规则？
