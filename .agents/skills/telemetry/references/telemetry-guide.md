# 遥测埋点详解（telemetry 引用文件）

> 本文件是 `telemetry` skill 的组成部分，由主 SKILL.md 引用。
> 做埋点 / 指标告警时必读。

## 1. 统一入口与装配

`Telemetry`（`kits/src/telemetry/telemetry.ts`）是普通类——构造器的 `windowSeconds` 是数值参数
（非注入 token），由 `TelemetryModule`（`@Global()`，无配置）用 `useFactory: () => new Telemetry()` 装配，
故刻意不标 `@Injectable()`。业务侧仅 `@Inject(Telemetry)` 使用，无需注册。
放置：横切基础能力 → `kits/foundation`。

## 2. 三个埋点方法

| 方法 | 用途 | 例子 |
| --- | --- | --- |
| `incr(name, by = 1)` | 计数器 | `telemetry.incr('order.count')` |
| `gauge(name, value)` | 仪表（当前值，覆盖式） | `telemetry.gauge('inventory.available', n)` |
| `histogram(name, value)` | 直方图（耗时 / 分布，对数桶） | `telemetry.histogram('request.duration', ms)` |

对数桶边界（ms）：`1…32768` 指数分布，样本超上限落入末桶。`snapshot().histograms[name]` 提供
`count` / `sum` / `quantile(p)`（p∈0..1，样本空返回 0）。

## 3. 指标命名约定

`<域>.<名称>`，kebab-case，如 `request.count` / `request.error` / `request.duration` /
`order.count` / `inventory.available`。同域前缀聚在一起，便于告警规则按名匹配。

## 4. 框架内置埋点（勿重复）

`common/request-metrics/request-metrics.middleware.ts` 在响应 finish 时自动埋：
`request.count`（+1）、`request.duration`（直方图，耗时 ms）、`request.error`（status ≥ 500 时 +1）。
运维探针路径（`isOpsProbePath`）跳过埋点。派生指标（错误率 / QPS / 平均耗时 / P95 / P99 / 内存）由
`AlertTrigger.buildMetricValues` 从 snapshot 计算，业务不用自算。

## 5. 业务埋点位置

在 service 关键路径埋业务指标（订单数、库存水位、任务耗时等），配合 monitor 的 metric / surge 规则告警：

```ts
constructor(@Inject(Telemetry) private readonly telemetry: Telemetry) {}
// 关键点
this.telemetry.incr('order.count')
this.telemetry.gauge('inventory.available', stock)
this.telemetry.histogram('job.duration', ms)
```

## 6. 快照与环比

`snapshot()` 滚动窗口：超 `windowSeconds` 时当前计数归档为 `previousCounters`（前一窗口基线），当前重置。
`surge` 告警规则用 `current / previous`（环比比值）；无基线或基线 ≤ 0 时跳过。原始 counter 告警按
rate（`value / windowSeconds`）比较，gauge 直接比较当前值。

## 7. 边界与注意

- 单实例进程内内存；多实例部署时各实例独立统计（后续接 Redis 聚合，当前未实现）。
- 直方图分位是近似值（对数桶），非精确分位；需要精确统计量时另用数据库聚合。
