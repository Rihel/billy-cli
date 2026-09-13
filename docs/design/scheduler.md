# 调度基础设施（定时器 + Cron）落地方案

> 目标：为工程提供**进程内**的定时器 / Cron 调度能力，与任务队列解耦。
> 引入 `croner` 作为 cron 引擎，封装为 `core/foundation` 的 `Scheduler` 门面。

## 1. 背景与能力定位

- 现状：工程已有 `QueueManager`（BullMQ）作**任务队列**（延迟投递用 `{ delay }`），
  但不提供进程内定时器 / Cron 周期调度。
- 诉求：**定时器 + cron 类组件**（进程内调度），与队列解耦。
- 选型：按「不重复造轮子」查找顺序——包内无实现 → 依赖无 cron 能力 → 联网选型，
  采用 **`croner`**（零依赖、TypeScript 原生、支持时区 / 秒级 / 漏跑恢复）。
  **不采用时间轮**：时间轮仅在高频海量短时定时器场景（如数万连接超时检测）才划算，
  当前业务 cron / 定时器场景用成熟 cron 库更可靠，不引入内存定时器在重启后丢失的复杂度。

## 2. 能力归位

| 项 | 决定 |
| --- | --- |
| 能力性质 | 横切基础能力（进程内调度器） |
| 落点 | `packages/kits/src/foundation/scheduler/scheduler.ts`（`Scheduler`） |
| 注册 | `SchedulerModule` 装配（`@Global()` 无配置纯模块，业务侧 `@Inject(Scheduler)`）；`foundation/index.ts` 导出 |
| 依赖 | `croner@^10.0.1`（kits），`vitest` 仅 devDependency |
| 错误 | `SchedulerError`（`AppErrorCodes.Internal`），加入 `infrastructure-errors.ts` |

归位依据：`placement.md` §7「横切基础能力 → core/foundation」、§5「定时任务/调度」。

## 3. 关键设计

- `scheduleCron(name, cronExpr, handler, opts?)`：cron 周期任务（透传 timezone / paused /
  protect / catch / mode），基于 croner 的 `Cron`。
- `scheduleInterval(name, ms, handler)`：固定间隔（`setInterval`）。
- `scheduleTimeout(name, ms, handler)`：单次延迟（`setTimeout`），触发后自动清理。
- 返回 `ScheduledJob` 句柄（`stop()` / `nextRun()`）。
- 任务名全局唯一，重复注册抛 `SchedulerError`。
- 处理器异常由调度器统一记日志并吞掉，单次失败不中断调度循环（cron 侧再叠加 croner
  的 `catch: true` 兜底）。
- 生命周期：`onApplicationShutdown()` 统一 `stopAll()` 清理全部任务（幂等）。

## 4. 使用示例

```ts
// 注册 cron（每天 0 点清理）
scheduler.scheduleCron('daily-cleanup', '0 0 * * *', async () => {
  // ...
}, { timezone: 'Asia/Shanghai' })

// 单次延迟（10 秒后执行）
scheduler.scheduleTimeout('refresh-token', 10_000, async () => {
  // ...
})

// 固定间隔（每 5 分钟心跳）
scheduler.scheduleInterval('heartbeat', 5 * 60_000, async () => {
  // ...
})
```

## 5. 测试

- 新增 `packages/kits/test/scheduler.test.ts`（vitest，`pnpm --filter @repo/kits test`）：
  覆盖 cron 周期触发、interval 周期、timeout 单次自动清理、重复注册抛错、
  handler 异常不中断循环、`stopAll` 后不再触发、非法时长抛错。

## 6. 注意事项 / 边界

- 进程内调度**不跨进程 / 不持久化**：进程重启后需重新注册；多实例部署时每个实例都会
  各自执行。需要可靠 / 分布式周期任务时应改用 `QueueManager` + BullMQ repeat（另案）。
- 任务 handler 是纯业务回调，异常已被吞掉；如需任务失败可观测，建议 handler 内部
  自行处理并返回结果，由调度器统一记日志兜底。
