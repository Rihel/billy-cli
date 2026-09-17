---
name: telemetry
description: 在 Billy 工程中使用遥测埋点：Telemetry 门面（Counter / Gauge / Histogram 窗口聚合与 snapshot 环比快照）、指标命名约定、框架自动埋点与业务埋点、metric / surge 指标告警。触发词：遥测、埋点、指标、metric、监控、Counter、Gauge、Histogram、Telemetry、snapshot、分位、P95、P99、QPS、错误率、指标告警、环比、surge。
---

# 遥测埋点（Telemetry）

前置：先加载必读 skill `billy-dev-foundation`（「不重复造轮子」实现查找顺序——埋点复用
`Telemetry` 门面，不自写计数器 / 直方图、不引 metrics 库；框架已自动埋请求指标，业务只补业务指标）。

## 核心要点

- 门面 `Telemetry`（`kits/src/telemetry/telemetry.ts`）：`incr(name, by?)` 计数、`gauge(name, value)`
  当前值、`histogram(name, value)` 直方图（对数桶 → 近似分位 P50/P95/P99）、`snapshot()` 窗口聚合快照。
- **指标命名 `<域>.<名称>`（kebab）**，如 `request.count` / `order.count` / `inventory.available`。
- 固定滚动窗口（默认 60s）：`snapshot()` 返回当前窗口 + 前一窗口（`previousCounters`，surge 环比基线）；
  rate = `counters[name] / windowSeconds`。
- **框架自动埋点**（`common/request-metrics` 中间件）：`request.count` / `request.error`（≥500）/
  `request.duration` 直方图；运维探针（healthz/readyz/info）不埋点，避免虚高 QPS / 错误率。
- **业务手动埋点**：构造器 `@Inject(Telemetry)`，在关键路径 `incr` / `gauge` / `histogram`。
- 消费参考：monitor 模块 `AlertTrigger` 用 `snapshot()` + `Scheduler` 周期评估 metric / surge 规则。
- 存储为进程内内存（单实例）；多实例聚合后续接 Redis。

## 参考文件（本 skill 的组成部分）

| 文件 | 内容 | 何时读 |
| --- | --- | --- |
| [references/telemetry-guide.md](./references/telemetry-guide.md) | 三方法语义、指标命名、内置指标、业务埋点位置、快照与环比告警、边界 | 埋点 / 做指标告警时（必读） |

## 完成检查清单

- [ ] 复用 `Telemetry` 门面（`@Inject(Telemetry)`），未自写计数器 / 直方图 / 未引 metrics 库
- [ ] 指标名符合 `<域>.<名称>`（kebab），语义清晰且不与其他段冲突
- [ ] 框架已埋的 `request.*` 不重复埋，业务只补业务指标
- [ ] 选对方法：当前值用 `gauge`，耗时 / 分布用 `histogram`，累计次数用 `incr`
- [ ] 需要告警时接 monitor 的 metric / surge 规则，不另写轮询
