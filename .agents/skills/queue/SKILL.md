---
name: queue
description: 在 Billy 工程中使用异步队列与延迟任务：基于 BullMQ 的 QueueManager 门面（addJob 生产者 / registerWorker 消费者）、任务重试、并发控制、延迟投递。触发词：队列、异步、任务、消息、延迟任务、队列消费、addJob、registerWorker、BullMQ、MQ、事件异步化。
---

# 异步队列与延迟任务

前置：先加载必读 skill `billy-dev-foundation`（「不重复造轮子」实现查找顺序见其
`references/code-conventions.md` 第 10 条——**用工程自带的 `QueueManager`，不引其它 MQ**）。

## 核心要点

- 基础设施 `QueueManager`（`core/infrastructure/queue.ts`，**BullMQ**）：生产者
  `addJob(queueName, name, data, options?)`，消费者 `registerWorker(queueName, handler, options?)`。
- **生产者**：投递任务，延迟用 `JobsOptions.delay`。
- **消费者**：业务模块构造期 `registerWorker`，Worker 在应用启动统一拉起；处理器抛错
  自动重试，最终失败记日志。
- **同一队列只允许一个 Worker**；并发默认 1，可传 `WorkerOptions` 调整。
- 生命周期由门面管理（启动拉起 / 停止先关 Worker 再关 Queue）。

## 参考文件（本 skill 的组成部分）

| 文件 | 内容 | 何时读 |
| --- | --- | --- |
| [references/queue-guide.md](./references/queue-guide.md) | 生产者 / 消费者代码、延迟任务、重试、并发、归位与幂等注意 | 用队列 / 异步 / 延迟任务时（必读） |

## 完成检查清单

- [ ] 复用 `QueueManager` 门面（`@Inject`），未自写 MQ / 未散落 `import bullmq`
- [ ] 消费者在构造期 `registerWorker`，处理器幂等、抛错可重试
- [ ] 延迟任务用 `delay`；并发数按需设置
- [ ] 同一队列未重复注册 Worker
- [ ] 队列名 / 任务名语义化，与业务对应
