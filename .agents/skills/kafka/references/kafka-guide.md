# Kafka 使用指南（kafka skill 引用文件）

> 本文件是 `kafka` skill 的组成部分，由主 SKILL.md 引用。

## 1. 装配与配置

`KafkaModule` 是 `@Global()`，但**只有被 import 才装配**。`apps/server/src/root.module.ts` 依
`KAFKA_BROKERS` 是否存在决定是否 import：

```ts
...(process.env.KAFKA_BROKERS
  ? [KafkaModule.forRootAsync({ imports: [ConfigModule], inject: [ConfigService],
      useFactory: (config) => config.get('kafka')! })]
  : []),
```

未配置时全应用没有 Kafka provider（业务里注入即解析报错），也不会尝试连 broker。

| 环境变量 | 默认 | 说明 |
| --- | --- | --- |
| `KAFKA_BROKERS` | 无（不配置则不装配） | 逗号分隔，如 `127.0.0.1:29092`；容器内为 `kafka:9092` |
| `KAFKA_CLIENT_ID` | `app` | 客户端标识 |
| `KAFKA_TOPIC_PREFIX` | `app` | 实际 topic = `<前缀>.<业务名>`；置空串表示不加前缀 |
| `KAFKA_GROUP_ID_PREFIX` | `app` | 实际 groupId = `<前缀>-<topic>-<suffix\|default>` |
| `KAFKA_CONNECTION_TIMEOUT_MS` | `3000` | 建连超时；kafkajs 默认 1s + 重试 5 次 ≈ 一次失败空转 10s |
| `KAFKA_REQUEST_TIMEOUT_MS` | `15000` | 单次请求超时 |
| `KAFKA_RETRY_COUNT` / `KAFKA_RETRY_INITIAL_DELAY_MS` | `2` / `300` | kafkajs 内部重试次数与初始间隔 |
| `KAFKA_UNAVAILABLE_COOLDOWN_MS` | `5000` | 快失败冷却期；期间 `send` 立即抛错（置 0 关闭） |

本地起 broker（compose 已带 profile，默认不启动）：

```bash
docker compose --profile kafka up -d     # kafka + kafka-ui(8085) + zookeeper
# apps/server/.env
KAFKA_BROKERS=127.0.0.1:29092
```

> 消费者并发上限 `consumerConcurrency`（默认 3）目前**没有映射环境变量**，需要调整时在
> `apps/server/src/app-config.ts` 的 `kafka` 命名空间里加映射（或改 schema 默认值）。

## 2. 生产者

```ts
import { KafkaService, KafkaUnavailableError } from '@repo/kits'

@Injectable()
export class OrderService {
  constructor(@Inject(KafkaService) private readonly kafka: KafkaService) {}

  async create(dto: OrderCreateDto) {
    const order = await this.repo.create(dto)
    // 对象自动 JSON 序列化；失败最多再试 1 次（有界），冷却期内快速失败
    try {
      await this.kafka.send('order.created', { orderId: order.id, amount: order.amount })
    } catch (error) {
      // Kafka 不可用不该让接口挂掉：降级为补偿（落表 / 重试 topic / scheduler 稍后补发）
      if (error instanceof KafkaUnavailableError) {
        await this.outbox.save({ topic: 'order.created', payload: { orderId: order.id } })
      } else {
        throw error
      }
    }
    return order
  }
}
```

- 第三参 `key` 用于**同键有序**（Kafka 只保证分区内有序；同 key 落同一分区）。
- `send` 是「投递成功即返回」，不代表消费成功——需要业务最终一致时按下文做补偿。
- 需要 `usePrefix: false` 时传第四个参数 `{ usePrefix: false }`（少见，多用于对接外部已有 topic）。

## 3. 消费者

在任何 provider 的方法上标注即可，**不需要注册到模块**（`KafkaConsumerScanner` 启动时扫描）：

```ts
@Injectable()
export class OrderEventsConsumer {
  constructor(
    @Inject(AppLogger) private readonly logger: AppLogger,
    @Inject(OrderRepository) private readonly orderRepo: OrderRepository,
  ) {}

  // 方法签名 (payload, topic, partition)；payload 为 JSON 解析结果（空消息为 null）
  @KafkaConsumer('order.created')
  async onCreated(payload: { orderId: string }, topic: string) {
    // 必须幂等：见 §5
    await this.orderRepo.markNotified(payload.orderId)
    this.logger.info('订单已通知', { orderId: payload.orderId, topic })
  }
}
```

- **同一 topic 多消费组**：`@KafkaConsumer('order.created', 'analytics')` → 组后缀进 groupId，
  两个组各收一份（广播语义）；不传则用 `default` 后缀。
- **同组多方法**：同一 topic 且同 `groupId` 的多个方法都会收到同一条消息（组内扇出）。
- topic 名建议 `<域>.<事件>`（`order.created` / `user.registered`），前缀由配置统一加。

## 4. 失败语义与可用性（务必知道）

**可用性优先**：连接是惰性的（DI 阶段不发网络请求），消费者建连走后台浮动 Promise，
所以 **broker 挂掉不会推迟服务启动**（实测黑洞地址 725ms 可用 vs 不配 Kafka 682ms）。
请求路径上的 `send` 则按快失败处理：

| 阶段 | 行为 |
| --- | --- |
| **broker 不可达时的 `send`** | 建连超时 + 有限重试（有界），随后进入冷却期；期间 `send` **立即**抛 `KafkaUnavailableError`（带 `retryAfterMs`）。实测：旧默认一次失败 37.2s → 新默认 1.02s，冷却期内 0ms |
| 消费者**启动**失败 | `p-retry` 重试 5 次（后台，指数退避），并发受 `consumerConcurrency`（默认 3）限制；全部失败只记 error 日志并提示「恢复后需重启」，不阻断应用启动 |
| **单条消息**处理异常 | 只记 `error` 日志，**不中断消费循环、不自动重投**（偏移照常推进） |

> 提示：`KafkaService.getAvailability()` 返回 `{ available, retryAfterMs, lastError }`，
> 可在健康检查/降级开关里用，但**不要**让 Kafka 状态决定服务是否可用。

所以「重试」不能指望 Kafka 自动完成。可选做法：

1. **处理器幂等 + 上游重放**：消息可重现时，靠重放补齐；
2. **落表 + `scheduler` 补偿**：失败写一张 `*_outbox` / 失败记录表，用 `scheduler`（croner）
   定期扫描重试；
3. **重试 topic**：消费失败时转投 `<topic>.retry`，另起低并发消费者延迟处理。

## 5. 幂等（at-least-once 的必修课）

消费组重平衡（rebalance）与偏移提交策略都会造成**同一条消息被重复投递**。处理器必须幂等：

- 用**数据库唯一约束**兜底最省事（如 `uk_*` 含业务幂等键）；
- 或先查后写 + 分布式锁（`concurrency` skill 的 `RedisStore.acquireLock`）；
- 记录已处理消息 id（幂等表）也是常见做法。

## 6. 与「队列」旧方案的关系（迁移提示）

本工程曾用 BullMQ 的 `QueueManager`（`addJob` / `registerWorker`），**已整体移除**
（无业务使用，且延迟语义与 MQ 定位重叠）。如果你在旧代码 / 旧 PR 里看到它：

| 旧（BullMQ） | 现在 |
| --- | --- |
| `addJob(queueName, name, data, { delay })` | `kafkaService.send(topic, payload, key?)` + 用 `scheduler` 做延迟触发 |
| `registerWorker(queueName, handler)` | `@KafkaConsumer(topic)` 标注方法 |
| `attempts` / `backoff` 自动重试 | 处理器幂等 + 上述 §4 的补偿方案 |
| repeatable job（cron） | `scheduler` skill 的 `scheduleCron` |
