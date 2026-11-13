# 队列基础设施（BullMQ）落地方案

> **已废弃（2026-09-15）：BullMQ 与 `QueueManager` / `QueueModule` 已从工程整体移除。**
> 原因：`QueueManager` 在业务侧**零使用**；且「异步消息」已由 Kafka 承担
> （`kits/src/kafka/` 的 `KafkaService` + `@KafkaConsumer`，见 `kafka` skill），
> 延迟 / 周期任务由 `foundation/scheduler`（croner）与 `foundation/time-wheel` 承担，
> 与 BullMQ 的定位重叠。本文仅作历史存档，**不要再按本文实现**。
>
> **现状（2026-11-13 核对）**：仓库中没有 `packages/kits/src/queue/`，`bullmq` / `QueueManager` /
> `QueueModule` 全仓零引用（`package.json` 也无该依赖）。当前异步与定时能力的实际归属：
>
> | 需求 | 现用能力 | 位置 |
> | --- | --- | --- |
> | 异步消息 / 事件驱动 | `KafkaService` + `@KafkaConsumer` | `packages/kits/src/kafka/` |
> | 进程内事件总线（at-most-once） | `EventBus` / `EventBusModule`（`events:<topic>`） | `packages/kits/src/events/` |
> | 跨实例广播 / 订阅传输 | `PubSub` / `PubSubModule` | `packages/kits/src/pubsub/` |
> | 延迟 / 周期任务 | `Scheduler`（croner） | `packages/kits/src/foundation/scheduler/` |
> | 高频毫秒级调度 | `TimeWheel` | `packages/kits/src/foundation/time-wheel/` |
>
> 因此本文是**方案稿 + 历史存档**，对应能力从未以 BullMQ 形态落地，也没有待补的实现工作。
>
> 目标：把 BullMQ 引入为工程**基础设施统一入口**（不是某个业务模块），
> 让业务模块通过统一入口生产 / 消费任务，不散落 `import bullmq`。

## 1. 能力定位与位置

> 以下 §1–§4 是**当时的方案设计**，其中的目录、模块、依赖与示例在当前仓库都不存在，
> 只用于理解「为什么当时会这么设计」；现状见文首表格。

| 项 | 决定 |
| --- | --- |
| 能力性质 | 外部资源统一入口（MQ / 任务队列） |
| 位置 | `packages/kits/src/queue/queue.ts`（`QueueManager` 统一入口）+ `queue.module.ts` |
| 注册 | `QueueModule` 装配（`@Global()`，复用 `RedisModule` 的 `RedisConfig`；业务侧 `@Inject(QueueManager)`），`queue/index.ts` 导出 |
| 依赖 | `bullmq` 加入 `packages/kits/package.json`（ioredis 已在依赖中，满足 BullMQ 的 peer） |

放置依据：`billy-dev-foundation/references/placement.md` §2「外部资源统一入口 → `kits/src/<基础设施>/`」、
§5「消息队列/延迟任务 → 统一入口 `kits/src/queue/queue.ts`」。

## 2. 关键设计

- **统一入口职责**：生产者 `addJob`、消费者 `registerWorker`、按需取队列 `getQueue`（raw 兜底）。
- **连接**：每个 `Queue` / `Worker` 独立建一个 ioredis 连接，从 `config.redis.url` 构造，
  设 `maxRetriesPerRequest: null`（Worker 阻塞命令所需）；prefix 取 `config.redis.keyPrefix ?? 'bull'`。
  连接由 BullMQ 自身管理（传入实例即被 Queue/Worker 接管，close 时释放）。
- **生命周期**：`onApplicationBootstrap` 启动全部已注册 Worker；`onApplicationShutdown` 依次关闭 Worker 与 Queue。
- **消费者注册**：业务模块在构造器注入 `QueueManager` 后调 `queueManager.registerWorker(name, handler)`，
  实际 Worker 在应用启动时统一拉起，处理失败交由 BullMQ 按 attempts 重试并记日志。
- **错误**：抛 `QueueError`（`AppErrorCodes.Internal`），不返回裸结果掩盖错误。

## 3. 使用示例

```ts
// 生产者（业务 service 内）
await queueManager.addJob('article', 'processArticle', { articleId }, { delay: 1000 })

// 消费者（业务 service 构造期注册）
queueManager.registerWorker<ArticleProcessPayload>('article', async (job) => {
  const { articleId } = job.data
  // ... 处理逻辑
})
```

## 4. 注意事项 / 边界

- 一个队列只允许注册一个 Worker（重复注册抛 `QueueError`）。
- 每个 Queue/Worker 独占连接，勿与 `RedisStore` 共用连接实例（避免 `maxRetriesPerRequest` 冲突）。
- 任务数据必须是可 JSON 序列化的纯对象。
