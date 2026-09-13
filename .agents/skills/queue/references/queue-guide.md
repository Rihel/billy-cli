# 异步队列详解（queue 引用文件）

> 本文件是 `queue` skill 的组成部分，由主 SKILL.md 引用。
> 使用队列 / 异步任务 / 延迟任务时必读。

## 1. 基础设施：QueueManager（kits/src/queue/queue.ts）

基于 **BullMQ** 的队列门面，注入 `@Inject(QueueManager)`（由 `QueueModule` 装配，`@Global()`，
复用 `RedisModule` 的 `RedisConfig`）。

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
export class OrderService implements OnApplicationBootstrap {
  constructor(@Inject(QueueManager) private readonly queue: QueueManager) {}

  // 构造器或 onApplicationBootstrap 里注册；Worker 由 QueueManager 启动钩子统一拉起
  onApplicationBootstrap(): void {
    this.queue.registerWorker('order.notify', async (job) => {
      const { orderId, email } = job.data
      // ...处理业务，抛错会自动触发队列重试
    }, { concurrency: 5 })   // 并发数可配
  }
}
```

- 构造器参数**必须显式 `@Inject(QueueManager)`**：项目用 tsx（esbuild）不产出
  `design:paramtypes`，漏写会静默注入 undefined。
- 处理器接收 `Job<T>`，返回 Promise；**抛错会交给 BullMQ 重试**，最终失败在
  `worker.on('failed')` 记日志。
- **同一队列只允许注册一个 Worker**，重复注册抛 `QueueError`。
- 默认 `concurrency: 1`，可按需传 `WorkerOptions` 提高并发。

## 4. 生命周期

- Worker 在应用启动（`QueueManager` 的 `onApplicationBootstrap`）统一拉起。
- 应用停止（`onApplicationShutdown`）先关 Worker 再关 Queue，优雅收尾。
- 连接从 `config.redis.url` 构造，前缀 `bull`，无需手管。

## 5. Kafka 消息（可选模块）

BullMQ 适合「本服务的后台任务」，Kafka 适合「跨服务事件流」。kits 用 `KafkaService` +
`@KafkaConsumer` 封装 kafkajs，**只在 `root.module.ts` 里 import 了 `KafkaModule.forRoot({ brokers })`
时才装配**（未 import 则 provider 不存在，用了即 Nest 解析报错）：

```ts
// 1) 声明消费者：启动时由 KafkaConsumerScanner 自动扫描并订阅
@Injectable()
export class OrderEventsConsumer {
  @KafkaConsumer('order.created')          // 第二参可给 groupId 后缀，同 topic 多消费组
  async onCreated(payload: unknown) { ... }
}

// 2) 生产
constructor(@Inject(KafkaService) private readonly kafka: KafkaService) {}
await this.kafka.send('order.created', { id: '1' })   // 非字符串自动 JSON 序列化
```

命名规则：实际 topic = `${topicPrefix}.${name}`，groupId = `${groupIdPrefix}-${topic}-${后缀}`，
避免多环境共用集群串 topic；`onApplicationShutdown` 统一断开生产者 / 消费者。
消费者启动失败重试 5 次、并发受 `consumerConcurrency` 限制；单条消息处理异常只记日志不中断循环。

## 6. 归位与注意

- 队列门面在 `kits/src/queue/`（一个基础设施一个目录）；业务模块只依赖 `QueueManager`，
  **不散落 import bullmq**。
- 任务处理器必须是幂等的（可能重试 / 重复消费）：用业务唯一键或 `concurrency` 控制。
- 长任务拆小、失败可重试；不可重试的任务在 handler 内 try/catch 决定吞掉或抛错。
- 新队列需求先按「实现查找顺序」确认用 `QueueManager`，不引其它 MQ。
