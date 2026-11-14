import { z } from 'zod'
import {
  AppConfigFacade,
  DbConfigSchema,
  envConfigLoader,
  LoggerConfigSchema,
  RedisConfigSchema,
} from '@repo/kits'

/**
 * model-gateway 的应用配置。
 *
 * 网关只读配置表（`ai_providers` / `ai_models`），不写库、不碰会话；
 * 唯一的写入口留给后续的 `model_gateway_usage`（P4.3b）。
 */
export const modelGatewayAppConfigSchema = z.object({
  server: z.object({
    port: z.coerce.number().int().positive().default(9992),
  }),
  logger: LoggerConfigSchema,
  db: DbConfigSchema,
  redis: RedisConfigSchema,
  gateway: z.object({
    /** runtime ↔ 网关的内部令牌；生产必须显式配置 */
    internalToken: z.string().min(1).default('dev-model-token'),
    /** 模型目录缓存时长（配置变更靠事件 + TTL 兜底） */
    cacheTtlMs: z.coerce.number().int().positive().default(30_000),
    /** 上游首字节超时（ms） */
    firstByteTimeoutMs: z.coerce.number().int().positive().default(120_000),
    /** 流中空闲超时（ms）：超过没有新块就 abort 上游 */
    idleTimeoutMs: z.coerce.number().int().positive().default(180_000),
  }),
})

export type ModelGatewayAppConfig = z.infer<typeof modelGatewayAppConfigSchema>

/** 网关配置 bean（模块自己的配置分片） */
export const ModelGatewayConfig = Symbol.for('ModelGatewayConfig')
export type ModelGatewayConfigValue = ModelGatewayAppConfig['gateway']

const optional = (value: string | undefined): string | undefined =>
  value === undefined || value === '' ? undefined : value

export const mapModelGatewayEnv = (env: NodeJS.ProcessEnv): Record<string, unknown> => ({
  server: {
    port: optional(env.MODEL_GATEWAY_PORT) ?? optional(env.PORT),
  },
  logger: {
    prefix: optional(env.LOG_PREFIX) ?? 'model-gateway',
    level: optional(env.LOG_LEVEL),
    pretty:
      env.LOG_PRETTY === undefined || env.LOG_PRETTY === ''
        ? undefined
        : env.LOG_PRETTY !== 'false',
  },
  db: {
    url: optional(env.DB_URL),
    poolSize: optional(env.DB_POOL_SIZE),
  },
  redis: {
    url: optional(env.REDIS_URL),
    keyPrefix: optional(env.REDIS_KEY_PREFIX),
  },
  gateway: {
    internalToken: optional(env.MODEL_INTERNAL_TOKEN),
    cacheTtlMs: optional(env.MODEL_GATEWAY_CACHE_TTL_MS),
    firstByteTimeoutMs: optional(env.MODEL_GATEWAY_FIRST_BYTE_TIMEOUT_MS),
    idleTimeoutMs: optional(env.MODEL_GATEWAY_IDLE_TIMEOUT_MS),
  },
})

export const loadModelGatewayAppConfig = (): Promise<ModelGatewayAppConfig> =>
  AppConfigFacade.initial({
    schema: modelGatewayAppConfigSchema,
    loader: envConfigLoader({ envFileName: '.env', mapEnv: mapModelGatewayEnv }),
  })
