# 队列基础设施（BullMQ）落地方案

> 目标：把 BullMQ 引入为工程**基础设施门面**（不是某个业务模块），
> 让业务模块通过统一门面生产 / 消费任务，不散落 `import bullmq`。

## 1. 能力定位与落点

| 项 | 决定 |
| --- | --- |
| 能力性质 | 外部资源门面（MQ / 任务队列） |
| 落点 | `packages/kits/src/queue/queue.ts`（`QueueManager` 门面）+ `queue.module.ts` |
| 注册 | `QueueModule` 装配（`@Global()`，复用 `RedisModule` 的 `RedisConfig`；业务侧 `@Inject(QueueManager)`），`queue/index.ts` 导出 |
| 依赖 | `bullmq` 加入 `packages/kits/package.json`（ioredis 已在依赖中，满足 BullMQ 的 peer） |

归位依据：`billy-dev-foundation/references/placement.md` §2「外部资源门面 → `kits/src/<基础设施>/`」、
§5「消息队列/延迟任务 → 门面 `kits/src/queue/queue.ts`」。

## 2. 关键设计

- **门面职责**：生产者 `addJob`、消费者 `registerWorker`、按需取队列 `getQueue`（raw 兜底）。
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
await queueManager.addJob('todo', 'processTodo', { todoId }, { delay: 1000 })

// 消费者（业务 service 构造期注册）
queueManager.registerWorker<TodoProcessPayload>('todo', async (job) => {
  const { todoId } = job.data
  // ... 处理逻辑
})
```

## 4. 注意事项 / 边界

- 一个队列只允许注册一个 Worker（重复注册抛 `QueueError`）。
- 每个 Queue/Worker 独占连接，勿与 `RedisStore` 共用连接实例（避免 `maxRetriesPerRequest` 冲突）。
- 任务数据必须是可 JSON 序列化的纯对象。
