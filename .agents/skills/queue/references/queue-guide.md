# 异步队列详解（queue 引用文件）

> 本文件是 `queue` skill 的组成部分，由主 SKILL.md 引用。
> 使用队列 / 异步任务 / 延迟任务时必读。

## 1. 基础设施：QueueManager（core/infrastructure/queue.ts）

基于 **BullMQ** 的队列门面，注入 `@Inject(QueueManager)`（生命周期组件，`addLifeCycleService` 注册）。

能力：

| 方法 | 用途 |
| --- | --- |
| `addJob<T>(queueName, name, data, options?)` | 生产者：投递一个任务（`options` 为 BullMQ `JobsOptions`，含 `delay` 延迟） |
| `registerWorker<T>(queueName, handler, options?)` | 消费者：注册处理器，应用启动时统一拉起 |
| `getQueue<T>(name)` | 按需取底层 Queue（未封装高级用法的兜底） |

## 2. 生产者：投递任务

```ts
// 业务 service 内
await this.queue.addJob('order.notify', 'send-email', { orderId, email })
// 延迟任务
await this.queue.addJob('order.timeout', 'auto-cancel', { orderId }, { delay: 30 * 60 * 1000 })
```

- `queueName` 是队列名（如 `order.notify`），`name` 是任务类型名。
- 延迟用 `JobsOptions.delay`；更多选项（优先级、去重 jobId 等）见 BullMQ `JobsOptions`。

## 3. 消费者：注册 Worker（构造期注册，启动时拉起）

```ts
@Injectable()
export class OrderService implements OnAppStart {
  constructor(@Inject(QueueManager) private readonly queue: QueueManager) {}

  // 构造器或 onAppStart 里注册；Worker 在 QueueManager.onAppStart 时统一拉起
  onAppStart(): void {
    this.queue.registerWorker('order.notify', async (job) => {
      const { orderId, email } = job.data
      // ...处理业务，抛错会自动触发队列重试
    }, { concurrency: 5 })   // 并发数可配
  }
}
```

- 处理器接收 `Job<T>`，返回 Promise；**抛错会交给 BullMQ 重试**，最终失败在
  `worker.on('failed')` 记日志。
- **同一队列只允许注册一个 Worker**，重复注册抛 `QueueError`。
- 默认 `concurrency: 1`，可按需传 `WorkerOptions` 提高并发。

## 4. 生命周期

- Worker 在应用启动（`QueueManager.onAppStart`）统一拉起。
- 应用停止（`onAppStop`）先关 Worker 再关 Queue，优雅收尾。
- 连接从 `config.redis.url` 构造，前缀 `bull`，无需手管。

## 5. 归位与注意

- 队列门面在 `core/infrastructure`（外部资源门面）；业务模块只依赖 `QueueManager`，
  **不散落 import bullmq**。
- 任务处理器必须是幂等的（可能重试 / 重复消费）：用业务唯一键或 `concurrency` 控制。
- 长任务拆小、失败可重试；不可重试的任务在 handler 内 try/catch 决定吞掉或抛错。
- 新队列需求先按「实现查找顺序」确认用 `QueueManager`，不引其它 MQ。
