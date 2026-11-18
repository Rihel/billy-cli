import { z } from 'zod'
import {
  AppConfigFacade,
  DbConfigSchema,
  envConfigLoader,
  LoggerConfigSchema,
  RedisConfigSchema,
} from '@repo/kits'

/**
 * capability-gateway 的应用配置。
 *
 * 网关连主库只用于写审计（`ai_tool_audit`）和读工具配置；不执行工具、不碰会话。
 */
export const toolGatewayAppConfigSchema = z.object({
  server: z.object({
    port: z.coerce.number().int().positive().default(9993),
  }),
  logger: LoggerConfigSchema,
  redis: RedisConfigSchema,
  db: DbConfigSchema,
  gateway: z.object({
    /** gateway / worker 之间的内部令牌；生产必须显式配置 */
    internalToken: z.string().min(1).default('dev-tool-token'),
    /**
     * 固定 worker 地址（本地开发 / 单 worker 部署）。
     * 注册表为空或不可用时的兜底；生产多 worker 应留空，走 Redis 注册表。
     */
    workerUrl: z.string().url().optional(),
    /** 注册表 freshness：超过这个时间没心跳就不选 */
    staleAfterMs: z.coerce.number().int().positive().default(30_000),
    /** 单次调用的安全上限；请求里的 deadlineMs 更小则听请求的（bash 默认 5 分钟） */
    invokeTimeoutMs: z.coerce.number().int().positive().max(360_000).default(310_000),
    /** 单用户 + 单工具每分钟调用上限（gateway 自己的限流，不是 facade 的 run 准入） */
    rateLimitPerMinute: z.coerce.number().int().positive().default(60),
    /**
     * 是否允许外部服务指向内网 / 回环地址（协议 §4.4 的 SSRF 防护）。
     * 留空按环境兜底：生产禁止、开发 / 测试放行；生产必须显式 false。
     */
    allowPrivateNetwork: z.coerce.boolean().optional(),
  }),
})

export type ToolGatewayAppConfig = z.infer<typeof toolGatewayAppConfigSchema>

export const ToolGatewayConfig = Symbol.for('ToolGatewayConfig')
export type ToolGatewayConfigValue = ToolGatewayAppConfig['gateway']

const parseBoolean = (value: string | undefined): boolean | undefined =>
  value === undefined || value === '' ? undefined : value !== 'false'

const optional = (value: string | undefined): string | undefined =>
  value === undefined || value === '' ? undefined : value

export const mapToolGatewayEnv = (env: NodeJS.ProcessEnv): Record<string, unknown> => ({
  server: {
    port: optional(env.TOOL_GATEWAY_PORT) ?? optional(env.PORT),
  },
  logger: {
    prefix: optional(env.LOG_PREFIX) ?? 'capability-gateway',
    level: optional(env.LOG_LEVEL),
    pretty:
      env.LOG_PRETTY === undefined || env.LOG_PRETTY === ''
        ? undefined
        : env.LOG_PRETTY !== 'false',
  },
  redis: {
    url: optional(env.REDIS_URL),
    keyPrefix: optional(env.REDIS_KEY_PREFIX),
  },
  db: {
    url: optional(env.DB_URL),
    poolSize: optional(env.DB_POOL_SIZE),
  },
  gateway: {
    internalToken: optional(env.TOOL_INTERNAL_TOKEN),
    workerUrl: optional(env.TOOL_WORKER_URL),
    staleAfterMs: optional(env.TOOL_WORKER_STALE_MS),
    invokeTimeoutMs: optional(env.TOOL_GATEWAY_TIMEOUT_MS),
    rateLimitPerMinute: optional(env.TOOL_GATEWAY_RATE_LIMIT_PER_MINUTE),
    allowPrivateNetwork: parseBoolean(env.TOOL_GATEWAY_ALLOW_PRIVATE_NETWORK),
  },
})

export const loadToolGatewayAppConfig = (): Promise<ToolGatewayAppConfig> =>
  AppConfigFacade.initial({
    schema: toolGatewayAppConfigSchema,
    loader: envConfigLoader({ envFileName: '.env', mapEnv: mapToolGatewayEnv }),
  })
