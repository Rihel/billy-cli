import { z } from 'zod'

/**
 * Kafka 组件配置（KafkaService / 消费者扫描器）。
 * brokers 支持数组或逗号分隔字符串；topic / groupId 前缀替代旧实现的硬编码前缀。
 */
export const KafkaConfigSchema = z.object({
  /** broker 列表，如 ['localhost:9092'] 或 'localhost:9092,localhost:9093' */
  brokers: z
    .union([z.string(), z.array(z.string())])
    .default('localhost:9092')
    .transform((value) =>
      (Array.isArray(value) ? value : value.split(',')).map((item) => item.trim()).filter(Boolean),
    ),
  /** 客户端标识 */
  clientId: z.string().default('app'),
  /** topic 前缀：最终 topic = `${topicPrefix}.${name}`；置空串表示不加前缀 */
  topicPrefix: z.string().default('app'),
  /** 消费组前缀：最终 groupId = `${groupIdPrefix}-${topic}-${suffix|default}` */
  groupIdPrefix: z.string().default('app'),
  /** 消费者并发启动上限，默认 3 */
  consumerConcurrency: z.number().int().positive().default(3),
  /**
   * 建连超时（ms），透传 kafkajs `connectionTimeout`。
   *
   * 默认 3s 是**有意的快失败**：kafkajs 默认 `connectionTimeout: 1000` 配 `retry.retries: 5`，
   * broker 不可达时一次 `connect()` 要空转十几秒 —— 若发生在请求路径上（发布事件），
   * 就会把 HTTP 请求一起拖住。
   */
  connectionTimeoutMs: z.coerce.number().int().positive().default(3_000),
  /** 单次请求超时（ms），透传 kafkajs `requestTimeout`；默认 15s */
  requestTimeoutMs: z.coerce.number().int().positive().default(15_000),
  /** kafkajs 内部重试次数（连不上 broker 时）；默认 2（kafkajs 默认 5 偏慢） */
  retryCount: z.coerce.number().int().nonnegative().default(2),
  /** kafkajs 内部重试初始间隔（ms）；默认 300 */
  retryInitialDelayMs: z.coerce.number().int().nonnegative().default(300),
  /**
   * 不可用冷却期（ms）：一次建连失败后，冷却期内所有 `send` / 建连**立即失败**，
   * 不再逐个去等超时（默认 5s，置 0 关闭该行为）。
   *
   * 这是「Kafka 挂了也不能拖慢服务」的关键：调用方要么快速降级（落表 / 进重试 topic），
   * 要么自己决定重试；而不是让请求线程和连接超时一起耗着。
   */
  unavailableCooldownMs: z.coerce.number().int().nonnegative().default(5_000),
})

export type KafkaConfig = z.infer<typeof KafkaConfigSchema>

/** DI 注入 token（KafkaConfig 是纯类型，用 Symbol 作运行时标识） */
export const KafkaConfig = Symbol.for('KafkaConfig')
