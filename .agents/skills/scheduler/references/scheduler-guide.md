# 定时调度详解（scheduler 引用文件）

> 本文件是 `scheduler` skill 的组成部分，由主 SKILL.md 引用。
> 使用定时任务 / 调度时必读。

## 1. 基础设施：Scheduler（kits/foundation/scheduler.ts）

基于 **croner** 的调度门面，注入 `@Inject(Scheduler)`（`addService` 注册）。归位：
横切基础能力 → `kits/foundation`。

| 方法 | 用途 |
| --- | --- |
| `scheduleCron(name, cronExpr, handler, options?)` | cron 周期触发（支持秒级 / 时区 / 漏跑恢复） |
| `scheduleInterval(name, ms, handler)` | 固定间隔触发（setInterval） |
| `scheduleTimeout(name, ms, handler)` | 单次延迟触发（setTimeout，触发后自动清理） |
| `stop(name)` / `stopAll()` | 停止任务 / 全部 |

返回 `ScheduledJob`（`{ name, stop(), nextRun?() }`）。

## 2. 注册任务

```ts
@Injectable()
export class OrderService {
  constructor(@Inject(Scheduler) private readonly scheduler: Scheduler) {}

  initSchedule(): void {
    // cron：每天 2 点跑一次对账
    this.scheduler.scheduleCron('order.reconcile', '0 2 * * *', () =>
      this.reconcile(),
    )
    // 间隔：每 30s 心跳
    this.scheduler.scheduleInterval('service.heartbeat', 30_000, () =>
      this.heartbeat(),
    )
    // 单次：5s 后执行
    this.scheduler.scheduleTimeout('demo.after-5s', 5_000, () => this.doOnce())
  }
}
```

## 3. 关键行为

- **名称唯一**：任务名在 `Scheduler` 内唯一，重复注册抛 `SchedulerError`。
- **异常吞掉保循环**：handler 抛错由调度器统一记日志并吞掉，**不会中断整个调度循环**；
  需要重试 / 告警的任务在 handler 内自行 try/catch 处理。
- **停止**：`stop(name)` 幂等；应用停止（`onAppStop`）统一 `stopAll()`。
- **时间**：cron 用 `croner` 语法（含秒级）；interval / timeout 传毫秒。

## 4. 归位与注意

- 调度器在 `kits/foundation`（横切基础能力）；业务模块注入 `Scheduler` 用，不散落 `croner`。
- 定时任务**跨实例会重复执行**：多实例部署时如需互斥，配合 `concurrency` skill 的
  `RedisStore.acquireLock` 加分布式锁（谁抢到谁执行）。
- 长任务建议配合 `queue` skill 拆异步，避免阻塞调度线程。
- 新调度需求先按「实现查找顺序」确认用 `Scheduler`，不引其它调度库。
