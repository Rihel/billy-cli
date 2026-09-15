---
name: kafka
description: 在 Billy 工程中使用 Kafka 做异步消息与事件驱动：kits 的 KafkaService 生产者（send 自动 JSON 序列化 + 重试）、@KafkaConsumer 注解式消费者（启动自动扫描订阅）、topic / 消费组前缀约定、at-least-once 下的幂等要求，以及「延迟 / 周期 / 重试」该交给 scheduler 而不是指望 MQ。触发词：Kafka、MQ、消息队列、异步、事件、生产者、消费者、topic、消费组、KafkaService、@KafkaConsumer、削峰、解耦、异步化、事件驱动。
---

# 异步消息与事件（Kafka）

前置：先加载必读 skill `billy-dev-foundation`（「不重复造轮子」实现查找顺序见其
`references/code-conventions.md` 第 10 条——**异步消息用工程自带的 Kafka 门面，不引其它 MQ**）。
延迟 / 周期任务见 `scheduler` skill；进度回推前端见 `stream` skill。

## 核心要点

- 能力组成：`KafkaService`（生产者 + 消费者获取）+ `@KafkaConsumer(topic, groupId?)` 注解 +
  `KafkaConsumerScanner`（启动时扫描全 provider 自动订阅）+ `KafkaModule`（`@Global()`）。
- **按需装配**：`root.module.ts` 依 `KAFKA_BROKERS` 是否存在决定是否 import `KafkaModule`；
  未配置则全应用没有 Kafka provider（用到即解析报错）。本地起 broker：
  `docker compose --profile kafka up -d`，宿主机连 `127.0.0.1:29092`、容器内连 `kafka:9092`。
- **生产者**：构造器 `@Inject(KafkaService)` → `send(topic, payload, key?)`。
  非字符串负载自动 `JSON.stringify`；失败最多再试 1 次（有界），随后进入快失败冷却期。
- **消费者**：在任意 provider 的方法上标 `@KafkaConsumer('topic')`，方法签名
  `(payload, topic, partition) => void | Promise<void>`，`payload` 为消息体 JSON 解析结果
  （空消息为 `null`）。**启动时自动订阅，不需要在模块里注册**。
- **消费组**：同一 topic 需要多个独立消费组时传第二参 `groupId`（作为后缀）；
  同一组内多个方法都会收到同一条消息。
- **命名**：实际 topic = `${KAFKA_TOPIC_PREFIX}.${topic}`（默认前缀 `app`，置空串则不加前缀）；
  groupId = `${KAFKA_GROUP_ID_PREFIX}-${topic}-${groupId ?? 'default'}`。
- **失败语义（必须知道）**：消费者**启动**失败重试 5 次、并发受 `consumerConcurrency` 限制
  （默认 3）；**单条消息处理异常只记日志，不中断消费循环、也不自动重投** → 处理器必须幂等，
  失败补偿自己安排（重试 topic / 落表 + `scheduler` 补偿）。
  5 次重试仍失败则在**本进程内不再自动重试**，Kafka 恢复后需重启服务。

## 可用性契约：Kafka 挂了不能拖住服务（改动这条要谨慎）

1. **不阻塞启动**：连接是**惰性**的 —— DI / 构造只建 kafkajs 客户端对象、不发网络请求；
   消费者扫描在 `onApplicationBootstrap` 里**同步返回**、建连走后台浮动 Promise
   （`KafkaConsumerScanner` 因此**不能改成 async**）。实测 broker 黑洞时服务 725ms 可用，
   不配 Kafka 是 682ms。
2. **不拖住请求（快失败）**：建连超时 / kafkajs 重试次数都用本模块的快失败默认值，
   一次失败后进入冷却期，期间 `send` **立即**抛 `KafkaUnavailableError`（带 `retryAfterMs`）。
   调用方据此快速降级（落表 / 进重试 topic / 返回业务成功但记待补），**不要**把 Kafka 故障
   传染成接口超时。

| 配置（env） | 默认 | 作用 |
| --- | --- | --- |
| `KAFKA_CONNECTION_TIMEOUT_MS` | 3000 | 建连超时（kafkajs 默认 1s + 重试 5 次 ≈ 一次失败空转 10s） |
| `KAFKA_REQUEST_TIMEOUT_MS` | 15000 | 单次请求超时 |
| `KAFKA_RETRY_COUNT` / `KAFKA_RETRY_INITIAL_DELAY_MS` | 2 / 300 | kafkajs 内部重试次数与初始间隔 |
| `KAFKA_UNAVAILABLE_COOLDOWN_MS` | 5000 | 快失败冷却期（置 0 关闭该行为） |

实测对照（broker 指向 `127.0.0.1:1`）：旧默认一次 `send` 失败要 **37.2s**（单次 connect 就 9.99s），
新默认 **1.02s**，冷却期内再次 `send` **0ms** 抛错。

## 与「延迟 / 周期 / 重试」的分工（别指望 MQ 兜底）

Kafka 是**分区日志 + 消费组**，没有 per-message 延迟投递、优先级、单条重投。对应关系：

| 需求 | 用什么 |
| --- | --- |
| 即时异步 / 削峰 / 跨服务解耦 / 事件驱动 | 本文：`KafkaService.send` + `@KafkaConsumer` |
| **延迟投递 / 定时 / 周期任务** | `scheduler` skill（croner 门面）或 `foundation/time-wheel`，触发后再 publish |
| 单条失败重试 / 死信 | 消费端自己实现（重试 topic、或落表 + `scheduler` 补偿） |
| 任务进度推给前端 | `stream` skill（SSE StreamHub） |

> **at-least-once**：消费组重平衡与偏移提交策略都会导致同一条消息被重复投递，
> 因此处理器必须幂等（DB 唯一约束兜底或业务幂等键）。

## 参考文件（本 skill 的组成部分）

| 文件 | 内容 | 何时读 |
| --- | --- | --- |
| [references/kafka-guide.md](./references/kafka-guide.md) | 生产者 / 消费者代码、装配与环境变量、命名与消费组、失败与幂等、与延迟任务的分工 | 用 Kafka / 异步消息时（必读） |

## 完成检查清单

- [ ] 生产者 / 消费者都经 `KafkaService` 与 `@KafkaConsumer`，未散落 `import kafkajs`
- [ ] `KAFKA_BROKERS` 已配置（否则 `KafkaModule` 根本不装配）
- [ ] 消费端**幂等**（at-least-once + 重平衡会重复投递）
- [ ] **Kafka 故障不影响接口可用性**：`send` 的失败按快失败处理（捕获
      `KafkaUnavailableError` → 降级 / 补偿），未让 broker 故障拖成请求超时
- [ ] 延迟 / 周期任务用 `scheduler` 或 `time-wheel`，未指望 Kafka 提供延迟投递
- [ ] topic 名语义化（建议 `<域>.<事件>`，如 `order.created`），需独立消费组时显式传 `groupId`
- [ ] 消息负载用共享契约（`@repo/shared` 的 Zod schema），不随手传内部对象
