import { z } from 'zod'
import {
  AppConfigFacade,
  DbConfigSchema,
  envConfigLoader,
  JwtConfigSchema,
  KafkaConfigSchema,
  LarkConfigSchema,
  LoggerConfigSchema,
  NotifyConfigSchema,
  PasswordConfigSchema,
  RedisConfigSchema,
  StorageConfigSchema,
} from '@repo/kits'

/**
 * 服务端应用配置 schema。
 *
 * 设计：**直接复用 kits 各模块的配置 schema** 组合成整份应用配置 ——
 * 单一事实源，一处校验 + 补默认值；落到各模块时只需 `ConfigService.get('<namespace>')`。
 * 不含 `db.entities`（类引用无法来自环境变量），由组合根在装配 `DbModule` 时补上。
 */
export const serverAppConfigSchema = z.object({
  /** 应用级业务配置（ServerConfig 命名空间） */
  server: z
    .object({
      /** HTTP 服务端口 */
      port: z.coerce.number().int().positive().default(9989),
      /** 用户体系开关：false 时关闭前台 / 后台两套鉴权，守卫直接放行 */
      authEnabled: z.boolean().default(true),
      /** 找回密码 token 有效期（分钟） */
      resetPasswordTokenTtlMinutes: z.coerce.number().int().positive().default(30),
      /** 限流豁免白名单（精确 IP / IPv4 CIDR） */
      rateLimitWhitelist: z.array(z.string()).default([]),
      /** 是否信任代理转发头（x-forwarded-for） */
      rateLimitTrustProxy: z.boolean().default(false),
      /**
       * 空闲长连接保持时长（ms），映射到 Node `server.keepAliveTimeout`。
       *
       * 默认 75s 的来由：前置网关（如 Kong）的上游连接池默认
       * `upstream_keepalive_idle_timeout = 60s`，而它**不认**后端响应头里的
       * `Keep-Alive: timeout=N` 提示。若后端比网关先关空闲连接，网关就会在
       * 「它以为还能复用」的窗口里往一个正在关闭的 socket 发请求 →
       * 间歇性 502 / `upstream prematurely closed connection`（且后端日志无痕，
       * 因为请求根本没到应用）。故后端必须比网关的上游空闲超时**更长**。
       */
      keepAliveTimeoutMs: z.coerce.number().int().positive().default(75_000),
      /**
       * 收完请求头的最长等待（ms），映射到 Node `server.headersTimeout`。
       *
       * **必须大于 `keepAliveTimeoutMs`**：否则长连接在被复用的瞬间可能因等待
       * 请求头超时而被销毁。注意 Node 对「headersTimeout ≤ keepAliveTimeout」
       * **不报错、静默接受**（实测确认），所以这里用 superRefine 显式拦住。
       */
      headersTimeoutMs: z.coerce.number().int().positive().default(80_000),
      /**
       * 部署版本标识（构建 / 发布时注入，如 git sha、镜像 tag），默认 `dev`。
       *
       * 只用于运维核对：`GET /info` 暴露它，滚动更新后确认线上实际跑的是哪个构建
       * （否则「更新了却没生效」只能靠猜）。
       */
      appVersion: z.string().default('dev'),
    })
    .superRefine((value, ctx) => {
      if (value.headersTimeoutMs <= value.keepAliveTimeoutMs) {
        ctx.addIssue({
          code: 'custom',
          path: ['headersTimeoutMs'],
          message:
            `headersTimeoutMs(${value.headersTimeoutMs}) 必须大于 ` +
            `keepAliveTimeoutMs(${value.keepAliveTimeoutMs})，` +
            '否则长连接被复用时可能因等待请求头超时被销毁',
        })
      }
    }),
  db: DbConfigSchema,
  redis: RedisConfigSchema,
  jwt: JwtConfigSchema,
  password: PasswordConfigSchema,
  storage: StorageConfigSchema,
  logger: LoggerConfigSchema,
  notify: NotifyConfigSchema,
  /** 告警业务配置（MonitorConfig 命名空间） */
  monitor: z.object({
    /** 告警总开关：false 时 notifyError 直接跳过 */
    enabled: z.boolean().default(true),
    /** 邮件告警默认接收人（email 通道的 to） */
    emailTo: z.string().optional(),
  }),
  /** 飞书应用凭据：未配置则不装配 LarkModule */
  lark: LarkConfigSchema.optional(),
  /** Kafka：未配置 brokers 则不装配 KafkaModule */
  kafka: KafkaConfigSchema.optional(),
})

export type ServerAppConfig = z.infer<typeof serverAppConfigSchema>

/** 空串视为未配置（env 常见写法 `KEY=`） */
const optional = (value: string | undefined): string | undefined =>
  value ? value : undefined

const parseBoolean = (value: string | undefined): boolean | undefined =>
  value === undefined ? undefined : value === 'true'

const parseList = (value: string | undefined): string[] | undefined =>
  value === undefined
    ? undefined
    : value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)

/**
 * 环境变量 → 嵌套配置。未设置的键留 `undefined`，由 schema 默认值兜底。
 */
export const mapServerEnv = (
  env: NodeJS.ProcessEnv,
): Record<string, unknown> => ({
  server: {
    port: optional(env.PORT),
    authEnabled:
      env.AUTH_ENABLED === undefined ? undefined : env.AUTH_ENABLED !== 'false',
    resetPasswordTokenTtlMinutes: optional(env.RESET_PASSWORD_TOKEN_TTL_MINUTES),
    rateLimitWhitelist: parseList(env.RATE_LIMIT_WHITELIST),
    rateLimitTrustProxy: parseBoolean(env.RATE_LIMIT_TRUST_PROXY),
    keepAliveTimeoutMs: optional(env.KEEP_ALIVE_TIMEOUT_MS),
    headersTimeoutMs: optional(env.HEADERS_TIMEOUT_MS),
    appVersion: optional(env.APP_VERSION),
  },
  db: {
    url: optional(env.DB_URL),
    sync: parseBoolean(env.DB_SYNC),
  },
  redis: {
    url: optional(env.REDIS_URL),
    keyPrefix: optional(env.REDIS_KEY_PREFIX),
  },
  jwt: {
    secret: optional(env.JWT_SECRET),
    expiresIn: optional(env.JWT_EXPIRES_IN),
  },
  password: {
    passwordHashRounds: optional(env.PASSWORD_HASH_ROUNDS),
  },
  storage: {
    provider: optional(env.OBJECT_STORAGE_PROVIDER),
    region: optional(env.OBJECT_STORAGE_REGION),
    bucket: optional(env.OBJECT_STORAGE_BUCKET),
    accessKeyId: optional(env.OBJECT_STORAGE_ACCESS_KEY_ID),
    secretAccessKey: optional(env.OBJECT_STORAGE_SECRET_ACCESS_KEY),
    endpoint: optional(env.OBJECT_STORAGE_ENDPOINT),
  },
  logger: {
    prefix: 'server',
    level: optional(env.LOG_LEVEL),
    pretty:
      env.NODE_ENV === undefined ? undefined : env.NODE_ENV !== 'production',
    loki: env.LOKI_HOST
      ? { host: env.LOKI_HOST, labels: { env: env.NODE_ENV ?? 'local' } }
      : undefined,
  },
  monitor: {
    enabled: env.ALERT_ENABLED === undefined ? undefined : env.ALERT_ENABLED !== 'false',
    emailTo: optional(env.ALERT_EMAIL_TO),
  },
  notify: {
    lark: env.LARK_NOTIFY_RECEIVE_ID
      ? {
          receiveId: env.LARK_NOTIFY_RECEIVE_ID,
          receiveIdType: optional(env.LARK_NOTIFY_RECEIVE_ID_TYPE),
        }
      : undefined,
    email: env.ALERT_SMTP_HOST
      ? {
          host: env.ALERT_SMTP_HOST,
          port: optional(env.ALERT_SMTP_PORT),
          secure:
            env.ALERT_SMTP_SECURE === undefined
              ? undefined
              : env.ALERT_SMTP_SECURE !== 'false',
          user: optional(env.ALERT_SMTP_USER),
          pass: optional(env.ALERT_SMTP_PASS),
          from: env.ALERT_SMTP_FROM ?? '',
        }
      : undefined,
  },
  lark:
    env.LARK_APP_ID && env.LARK_APP_SECRET
      ? {
          appId: env.LARK_APP_ID,
          appSecret: env.LARK_APP_SECRET,
          domain: optional(env.LARK_DOMAIN),
        }
      : undefined,
  kafka: env.KAFKA_BROKERS
    ? {
        brokers: env.KAFKA_BROKERS,
        clientId: optional(env.KAFKA_CLIENT_ID),
        topicPrefix: optional(env.KAFKA_TOPIC_PREFIX),
        groupIdPrefix: optional(env.KAFKA_GROUP_ID_PREFIX),
        // 快失败相关（不填走 kits 默认：3s / 15s / 2 次 / 300ms / 5s 冷却）
        connectionTimeoutMs: optional(env.KAFKA_CONNECTION_TIMEOUT_MS),
        requestTimeoutMs: optional(env.KAFKA_REQUEST_TIMEOUT_MS),
        retryCount: optional(env.KAFKA_RETRY_COUNT),
        retryInitialDelayMs: optional(env.KAFKA_RETRY_INITIAL_DELAY_MS),
        unavailableCooldownMs: optional(env.KAFKA_UNAVAILABLE_COOLDOWN_MS),
      }
    : undefined,
})

/**
 * 加载并缓存服务端配置。**必须在 `NestFactory.create` 之前调用**：
 * 各模块的 `forRootAsync` 工厂是惰性的，但都要读到已加载的配置。
 */
export const loadServerAppConfig = (): Promise<ServerAppConfig> =>
  AppConfigFacade.initial({
    schema: serverAppConfigSchema,
    // 换来源只改这一行（如 `loader: 'consul', loaderOptions: { baseURL, key }`），shape 不变
    loader: envConfigLoader({ envFileName: '.env', mapEnv: mapServerEnv }),
  })
