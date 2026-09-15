---
name: scheduler
description: 在 Billy 工程中使用定时调度：基于 croner 的 Scheduler 门面（scheduleCron / scheduleInterval / scheduleTimeout）、任务名唯一、异常吞掉保循环、多实例互斥（配合分布式锁）；高频毫秒级调度用 TimeWheel 时间轮。触发词：定时、调度、cron、定时任务、定时器、周期任务、时间轮、time-wheel、高频调度、scheduleCron、scheduleInterval、scheduleTimeout。
---

# 定时调度

前置：先加载必读 skill `billy-dev-foundation`（「不重复造轮子」实现查找顺序见其
`references/code-conventions.md` 第 10 条——**用工程自带的 `Scheduler`，不引其它调度库**）。
多实例互斥时配合 `concurrency` skill 的分布式锁。

## 核心要点

- 基础设施 `Scheduler`（`kits/src/foundation/scheduler/scheduler.ts`，**croner**，由 `SchedulerModule` 装配）：`scheduleCron` /
  `scheduleInterval` / `scheduleTimeout`，均要求任务名唯一（重复抛 `SchedulerError`）。
- **异常吞掉保循环**：handler 抛错由调度器记日志并吞掉，不中断调度；需重试/告警的任务
  在 handler 内自行处理。
- 应用停止统一清理；`stop(name)` 幂等。
- **多实例重复执行**：跨实例需配合 `RedisStore.acquireLock` 互斥（谁抢到谁执行）。
- **高频毫秒 / 秒级调度别用本门面，用 `TimeWheel`**（`kits/src/foundation/time-wheel/`）：
  时间轮面向「大量任务 + 毫秒级精度」（限流窗口、批量节流、心跳轮），O(1) 槽位插入，
  带自适应补偿与落后任务防堆积；是**普通类**不是 DI 门面，用
  `new TimeWheel(tickDuration, wheelsCount)` 自行 `start()` / `stop()`。
  本门面的 `scheduleInterval` 面向秒级以上的少量命名任务。

## 参考文件（本 skill 的组成部分）

| 文件 | 内容 | 何时读 |
| --- | --- | --- |
| [references/scheduler-guide.md](./references/scheduler-guide.md) | 三种注册方式代码、名称唯一、异常处理、多实例互斥、归位 | 用定时 / 调度时（必读） |

## 完成检查清单

- [ ] 复用 `Scheduler` 门面（`@Inject`），未散落 `croner` / 未引其它调度库
- [ ] 任务名语义化且唯一
- [ ] 可重试 / 需告警的任务在 handler 内自行处理异常，不依赖调度器
- [ ] 多实例部署的定时任务已用分布式锁互斥
- [ ] 长任务已考虑配合 `kafka` 拆异步
