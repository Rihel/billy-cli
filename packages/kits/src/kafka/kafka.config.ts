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
})

export type KafkaConfig = z.infer<typeof KafkaConfigSchema>

/** DI 注入 token（KafkaConfig 是纯类型，用 Symbol 作运行时标识） */
export const KafkaConfig = Symbol.for('KafkaConfig')
