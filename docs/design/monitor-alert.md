# 监控告警模块落地方案（monitor-alert）

> 目标：为工程提供**可管理的告警能力**——独立业务模块，告警规则在 admin 后台配置。
> **架构：埋点（Telemetry）→ 窗口聚合 → 规则评估（event / metric / surge）→ 通知**。
> 规则三类：事件规则（错误码 / 关键字 + 次数阈值）、指标规则（错误率 / P95 / P99 / 库存等
> 阈值）、突变规则（QPS 飙升 / 请求洪峰 / 订单飙升等环比基线）。
> 发送走通用通知模块（见 [notifier.md](./notifier.md)，含**默认文件输出通道 FileClient**）。
> 配套轻量健康检查端点。

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
| 规则实体 | `alert_rules` 扩展：`threshold` / `thresholdWindowSeconds`（event）+ `metric` / `operator` / `thresholdValue` / `periodSeconds`（metric / surge） |
| 评估引擎 | `apps/server/src/modules/monitor/alert-trigger.ts`（`AlertTrigger`）：事件计数窗口 + `Scheduler` 周期评估 metric / surge |
| 框架埋点 | `apps/server/src/common/request-metrics/request-metrics.middleware.ts`（`main.ts` 用 `app.use()` 注册）+ `modules/monitor/monitor.controller.ts`：全局请求埋点（耗时直方图 / 请求数 / 5xx）+ 内存采样 |
| 路由 / SDK / admin | 同第一版（/monitor/* + monitor 段 SDK + 规则 Drawer 加阈值与指标配置） |
| 依赖 | 零新增（文件输出用 node fs；分位 / 窗口自研） |

## 3. 埋点 API（kits Telemetry）

```ts
// 指标名约定：<域>.<名称>，kebab 化，如 request.duration / order.count / inventory.available
// telemetry 由构造器注入：@Inject(Telemetry) private readonly telemetry: Telemetry
telemetry.incr('request.count')                  // 计数器 +1（可带 labels）
telemetry.incrBy('request.error', 1)
telemetry.histogram('request.duration', 320)     // 直方图：记录耗时（ms）
telemetry.gauge('inventory.available', 5)        // 仪表：设置当前值

// 读取（评估引擎用）：
telemetry.snapshot()                             // { counters, gauges, histograms, window }
```

- **窗口聚合**：`windowSeconds`（默认 60s）内聚合——Counter 取窗口增量（错误率 = 错误 / 总数；
  QPS = 计数 / 窗口），Histogram 取窗口内分位数（P50 / P95 / P99），Gauge 取当前值；
- **分位数**：固定对数桶直方图，近似分位；
- **指标注册**：`Telemetry.register(name, { type, unit?, description? })` 命名约定（可选，
  防乱埋），未注册的指标按类型自动推断。

## 4. 规则模型（三类统一）

| 规则类型 | 匹配字段 | 评估 | 示例 |
| --- | --- | --- | --- |
| `event`（tech / business） | matchCodes / keywords + `threshold`（窗口内次数 ≥ N）+ `thresholdWindowSeconds` | 事件计数窗口，达到阈值才告警 | 错误码 1000 60s ≥ 5 次 |
| `metric` | `metric`（指标名）+ `operator`（gt / gte / lt / lte）+ `thresholdValue` + `periodSeconds` | 周期取指标 vs 阈值 | 错误率 > 0.05、P99 > 500ms、inventory.available < 10 |
| `surge` | `metric` + `operator` + `thresholdValue`（倍率）+ `periodSeconds` + 环比基线 | 当前窗口 / 前一窗口 比值 vs 阈值 | QPS 环比 > 3（洪峰）、order.count 环比 > 3（订单飙升） |

- 公共字段：name / level / channels / throttleSeconds / enabled（同第一版）。
- 语义：event 是「有事件才评估」；metric / surge 是「周期采样评估」（Scheduler 驱动）。

## 5. 评估引擎（AlertTrigger）

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
- **server**：`AlertTrigger` 扩展（event 次数阈值、metric 评估、surge 环比、限频复用）；
- 端到端：请求埋点后指标可见、metric 规则触发、文件输出落盘。

## 8. 边界 / 注意

- 指标进程内存态：单实例窗口聚合；重启清零（模板可接受，多实例后续接 Redis）；
- 分位数为固定桶近似（对数桶），精度满足告警场景（P99 告警不追求精确值）；
- surge 环比需要基线窗口：第一版「当前窗口 / 前一个窗口」，首个窗口无基线跳过；
- 文件输出为追加写（append），注意磁盘；`NotifyConfig.file.path` 可配（默认 `logs/alerts.log`）；
- `/monitor/*` admin 鉴权（health 免鉴权）；`AUTH_ENABLED=false` 守卫放行。

## 9. 评审确认点

1. 指标存储进程内内存（单实例，重启清零）——确认？
2. 分位用固定对数桶近似（P50/P95/P99）——确认？
3. surge 环比基线第一版实现（当前窗口 / 前一窗口）——确认？
4. Telemetry 归 kits（通用埋点，任何业务可用）——确认？
5. FileClient 默认文件输出（`logs/alerts.log`，始终可用）——确认？
