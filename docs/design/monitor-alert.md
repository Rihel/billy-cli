# 监控告警模块落地方案（monitor-alert）

> 目标：为工程提供**可管理的告警能力**——独立业务模块，告警规则在 admin 后台配置。
> **架构：埋点（Telemetry）→ 窗口聚合 → 规则评估（event / metric / surge）→ 通知**。
> 规则三类：事件规则（错误码 / 关键字 + 次数阈值）、指标规则（错误率 / P95 / P99 / 库存等
> 阈值）、突变规则（QPS 飙升 / 请求洪峰 / 订单飙升等环比基线）。
> 发送走通用通知模块（见 [notifier.md](./notifier.md)，含**默认文件输出通道 FileClient**）。
> 配套轻量健康检查端点。
>
> **现状（2026-11-13）——本文的规则引擎部分已被 [monitor-engine.md](./monitor-engine.md) 取代**，
> 保留本文作为告警能力的选型与埋点设计记录。差异清单：
> - 规则不再分 `tech / business / metric / surge` 四类：现为 `kind: event | metric` +
>   `driver: batch | stream`（`monitor-engine.md` §7.1）；「突变 / 环比」没有单独类型；
> - 规则表由 `alert_rules` 改为 `monitor_rules`（代码声明规则 + 库里只存配置与开关，
>   后台不能新建）；告警记录写 `monitor_alerts`，逐通道发送记录写 `alert_logs`；
> - 评估引擎由 `AlertTrigger` 一个类改为 `MonitorEngine` 编排 + `RuleEvaluatorService` /
>   `EventRuleService` / `AlertLifecycleService` / `AlertDeliveryService` 各司其职；
> - 规则接口已重构（`rule/definitions|list|update|reset`，旧的 `rule/create|page-query|remove`
>   已删除），完整清单见 `monitor-engine.md` §11.1；
> - 指标不再只存在进程内存：`monitor_metric_samples` 落库（raw / derived），
>   指标源为 `Telemetry.drainCompleted()` + `process` + AI 日表。
>
> 仍然成立的部分：Telemetry 埋点 API（§3）、通道 `file / lark / email`（§6）、
> 文件输出兜底（`logs/alerts.log`）、健康检查 `/monitor/health`（免鉴权）。

## 1. 背景与选型

- 现状：第一版告警仅「错误码 / 关键字」事件匹配，**无阈值、无指标、无埋点**——
  hold 不住 P99 / 错误率 / QPS 飙升 / 洪峰 / 库存告警等场景，重设计。
- 诉求（已确认）：
  1. **埋点数据收集**：定义指标，server 各位置埋点——框架层自动埋（请求耗时 / 计数 /
     错误率 / QPS / 内存），业务层手动埋（库存 / 订单等一行调用）；
  2. **规则可配置**：三类规则（event / metric / surge），admin 管理；
  3. **通知默认文件输出**：`FileClient`（无配置即用，告警落文件），lark / email 配置后
     走真实通道；
  4. 配套健康检查 `/monitor/health`。
- 选型结论：
  - **指标存储**：**进程内内存**（单实例，窗口聚合 + 周期评估；重启清零，模板够用；
    多实例后续接 Redis 聚合）；
  - **分位数**：**固定桶直方图**（对数桶近似 P50 / P95 / P99，内存可控）；
  - **突变基线**：环比（当前窗口 / 前一窗口比值），洪峰检测第一版实现；
  - **通知**：FileClient（node fs 追加写，零依赖，始终可用）+ 既有 LarkClient / EmailClient；
  - **评估**：`Scheduler` 周期任务（metric / surge 规则按 periodSeconds 评估）。

## 2. 能力放在哪

| 项 | 决定 |
| --- | --- |
| 遥测层（通用埋点） | `packages/kits/src/telemetry/`：`Telemetry` 统一入口（Counter / Histogram / Gauge + 窗口聚合 + 分位计算 + 指标注册），由 `TelemetryModule` 装配（`@Global()` 无配置纯模块）；**任何业务可埋点** |
| 文件输出通道 | `packages/kits/src/notification/file/`：`FileClient`（通知写文件，默认 `logs/alerts.log`，始终 configured） |
| 通知统一入口 | `notifier.ts` 增加 `file` 通道（默认：无真实通道配置时兜底文件输出） |
| 规则实体 | ~~`alert_rules` 扩展~~ → **现为 `monitor_rules`**（`rule_key` / `kind` / `driver` / `config` jsonb / `enabled` / `deprecated`），本表结构见 `monitor-engine.md` §9.1；告警记录 `monitor_alerts`、发送记录 `alert_logs` |
| 评估引擎 | ~~`apps/server/src/modules/monitor/alert-trigger.ts`（`AlertTrigger`）~~ → 现为 `apps/server/src/modules/monitor/engine/monitor.engine.ts`（`MonitorEngine`：启动对账 + 槽位编排 + 异常入口）+ `rule-evaluator.service.ts` / `event-rule.service.ts` / `alert-lifecycle.service.ts` / `alert-delivery.service.ts` |
| 框架埋点 | `apps/server/src/common/request-metrics/request-metrics.middleware.ts`（`RequestMetricsMiddleware`，由 `RequestMetricsModule` 自注册）+ 指标定义在 `apps/server/src/modules/monitor/metrics/system/{raw,derived}/`：全局请求埋点（耗时直方图 / 请求数 / 5xx）+ 内存采样 |
| 路由 / SDK / admin | `/monitor/*` 接口清单见 `monitor-engine.md` §11.1（rule/definitions、rule/list、rule/update、rule/reset、alert/page-query、alert/detail、metric/definitions、metric/series、metric/latest、engine/status、log/page-query、test、health）；SDK `client.monitor.*`；admin 页面 `apps/admin/src/app/(app)/main/monitor/{status,live,metrics,logs,rules}` |
| 依赖 | 零新增（文件输出用 node fs；分位 / 窗口自研） |

## 3. 埋点 API（kits Telemetry）

```ts
// 指标名约定：<域>.<名称>，kebab 化，如 request.duration / order.count / inventory.available
// telemetry 由构造器注入：@Inject(Telemetry) private readonly telemetry: Telemetry
telemetry.incr('request.count')                  // 计数器 +1
telemetry.incr('request.error', 1)               // 计数器 +by（签名是 incr(name, by?)
telemetry.histogram('request.duration', 320)     // 直方图：记录耗时（ms）
telemetry.gauge('inventory.available', 5)        // 仪表：设置当前值

// 读取：
telemetry.snapshot()                             // 当前窗口 + 前一窗口（counters / previousCounters / gauges / histograms）
telemetry.drainCompleted()                       // 取走所有已结束窗口（监控采集用）
```

> 实现的 `Telemetry` 实际 API 只有 `incr(name, by?)` / `gauge` / `histogram` / `snapshot` /
> `drainCompleted`（`packages/kits/src/telemetry/telemetry.ts`）——本文原来写的
> `incrBy` 与 `register(name, { type, unit, description })` 都没有实现；指标注册现在由
> 监控模块的 `MetricRegistry` 承担（`defineMetric` 定义 + `MonitorRegistry.register` + 启动校验），
> 未注册的 `Telemetry` 指标名不会被采集。`Telemetry` 不标 `@Injectable()`，由 `TelemetryModule` 用
> `useFactory` 装配（构造参数是数值窗口，不是注入 token）。

- **窗口聚合**：`windowSeconds`（默认 60s）内聚合——Counter 取窗口增量（错误率 = 错误 / 总数；
  QPS = 计数 / 窗口），Histogram 取窗口内分位数（P50 / P95 / P99），Gauge 取当前值；
- **分位数**：固定对数桶直方图，近似分位；
- **窗口对齐**：落地时 `Telemetry` 已按墙钟对齐窗口并加 `drainCompleted()`（见
  `monitor-engine.md` §6.6），采集器逐窗口取走，不再依赖懒滚动。

## 4. 规则模型（三类统一）

> 现状差异（2026-11-13）：最终实现只保留 `event` / `metric` 两种 `kind`，另用 `driver`
> 区分 `batch` / `stream`；`surge`（环比）没有独立类型，也没有内置的 QPS 飙升规则。
> 规则的公共配置字段现为 `enabled / operator / threshold / channels / silenceSeconds /
> level / recoverAfterWindows / notifyOnRecovery? / dimensionType? / dimensionKey?`，
> 见 `monitor-engine.md` §7.1。下表是本文当时的三类模型记录。

| 规则类型 | 匹配字段 | 评估 | 示例 |
| --- | --- | --- | --- |
| `event`（tech / business） | matchCodes / keywords + `threshold`（窗口内次数 ≥ N）+ `thresholdWindowSeconds` | 事件计数窗口，达到阈值才告警 | 错误码 1000 60s ≥ 5 次 |
| `metric` | `metric`（指标名）+ `operator`（gt / gte / lt / lte）+ `thresholdValue` + `periodSeconds` | 周期取指标 vs 阈值 | 错误率 > 0.05、P99 > 500ms、inventory.available < 10 |
| `surge` | `metric` + `operator` + `thresholdValue`（倍率）+ `periodSeconds` + 环比基线 | 当前窗口 / 前一窗口 比值 vs 阈值 | QPS 环比 > 3（洪峰）、order.count 环比 > 3（订单飙升） |

- 公共字段：name / level / channels / throttleSeconds / enabled（同第一版）。
- 语义：event 是「有事件才评估」；metric / surge 是「周期采样评估」（Scheduler 驱动）。

## 5. 评估引擎（AlertTrigger）

> 现状（2026-11-13）：`AlertTrigger` 已整体替换为 `MonitorEngine`（启动对账 + 槽位编排 +
> 异常入口）。`notifyError` 由 `MonitorEngine.ingestError(error, context)` 承担（错误码 /
> 关键字匹配 → Redis 计次 → 事件规则）；metric 规则由 `RuleEvaluatorService` 在
> `monitor:eval:<slot>` 锁内评估（不再读 `Telemetry.snapshot()`，而是读
> `monitor_metric_samples`）；通知投递与落库由 `AlertDeliveryService` /
> `AlertLifecycleService` 完成。本节保留当时的引擎设计记录。

- `notifyError(error, context)`：事件规则匹配（错误码 / 关键字 + **次数阈值窗口**）→
  超阈值 → 发送 + 落审计（第一版逻辑保留，加 threshold 判定）；
- `Scheduler` 注册周期任务：遍历 enabled 的 metric / surge 规则 → 取
  `Telemetry.snapshot()` 评估 → 超阈值 → 发送 + 落审计（限频 / 通知复用现有链路）；
- **默认规则兜底**：规则表为空时技术错误走配置通道 + 文件输出（FileClient 始终可用）。

## 6. 通知模块（引用 notifier.md）

- 通道：`file`（默认，始终可用）→ `lark` / `email`（配置后启用）；
- 规则 channels 增加 `file` 选项；未配置真实通道时默认写入文件（`logs/alerts.log`）。

## 7. 测试

- **kits**：`test/telemetry.test.ts`（Counter 窗口增量 / Histogram 分位近似 / Gauge 当前值 /
  错误率与 QPS 计算）、`test/file-client.test.ts`（写文件、append、路径配置）；
- **server**：现为监控模块的测试面（见 `monitor-engine.md` §13）：采集 / 派生 / 规则评估 /
  告警生命周期 / 投递 / 引擎槽位；`AlertTrigger` 已不存在；
- 端到端：请求埋点后指标可见、metric 规则触发、文件输出落盘。

## 8. 边界 / 注意

- 指标存储：**已由进程内存改为落库** `monitor_metric_samples`（raw / derived，保留期
  `MONITOR_SAMPLE_RETENTION_DAYS` 默认 30 天），多实例各自采自己那部分；
  本文当时「重启清零、多实例后续接 Redis」的取舍已不适用；
- 分位数为固定桶近似（对数桶），精度满足告警场景（P99 告警不追求精确值）；
- surge 环比没有落地为独立规则类型（见 §4 现状差异）；
- 文件输出为追加写（append），注意磁盘；`NotifyConfig.file.path` 可配（默认 `logs/alerts.log`，
  但应用配置目前只从 env 映射 lark / email 两段，路径实际上取默认值）；
- `/monitor/*` admin 鉴权（`/monitor/health` 免鉴权）；`AUTH_ENABLED=false` 守卫放行。

## 9. 评审确认点

> 落定结果（2026-11-13）：① 指标存储已换为 `monitor_metric_samples` 落库（不再是纯进程内存）；
> ② 分位仍为固定对数桶近似；③ surge 环比未实现为规则类型；④ Telemetry 归 kits 成立；
> ⑤ FileClient 默认文件输出成立。以下为当时的确认点原文。

1. 指标存储进程内内存（单实例，重启清零）——确认？
2. 分位用固定对数桶近似（P50/P95/P99）——确认？
3. surge 环比基线第一版实现（当前窗口 / 前一窗口）——确认？
4. Telemetry 归 kits（通用埋点，任何业务可用）——确认？
5. FileClient 默认文件输出（`logs/alerts.log`，始终可用）——确认？

## 10. 环境变量（告警链路，2026-11-13）

| 环境变量 | 含义 |
| --- | --- |
| `ALERT_ENABLED` | 告警总开关（默认 `true`）；`false` 时 `MonitorEngine.ingestError` 直接跳过 |
| `ALERT_EMAIL_TO` | 技术错误告警的默认邮件收件人（email 通道的 `to`；未配则该通道发送失败落 `alert_logs`） |
| `MONITOR_INSTANCE_ID` | 实例标识（缺省 `hostname:pid`） |
| `MONITOR_SAMPLE_RETENTION_DAYS` | 样本保留天数（默认 30） |
| `LARK_NOTIFY_RECEIVE_ID` / `_TYPE` | 飞书通道收件人（见 `notifier.md` §9） |
| `ALERT_SMTP_*`（HOST / PORT / SECURE / USER / PASS / FROM） | 邮件通道 SMTP（见 `notifier.md` §9） |

告警落库：一条告警的生命周期在 `monitor_alerts`（`status` / `first_fired_at` /
`last_fired_at` / `recovered_at` / `duration_ms` / `first_snapshot` / `last_snapshot`），
每次通道发送写一条 `alert_logs`（`alert_id` / `channel` / `status` / `error` / `sent_at`）。
实时推送走 SSE 的 `alert.fired` 事件（频道 `admin:all`，见 `sse.md`）。
