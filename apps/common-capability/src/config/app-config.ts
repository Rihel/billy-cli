import { tmpdir } from 'node:os'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import {
  AppConfigFacade,
  DbConfigSchema,
  envConfigLoader,
  LoggerConfigSchema,
  RedisConfigSchema,
  StorageConfigSchema,
  WorkspaceConfigSchema,
} from '@repo/kits'

/**
 * common-capability 的应用配置。
 *
 * 只包含 worker 自己需要的东西：端口、内部令牌、Redis（注册表）、工作区沙箱、执行上限。
 * 不依赖主库、不依赖 provider key —— 这是「数据面」的边界。
 */
export const toolWorkerAppConfigSchema = z.object({
  server: z.object({
    port: z.coerce.number().int().positive().default(9994),
  }),
  logger: LoggerConfigSchema,
  redis: RedisConfigSchema,
  db: DbConfigSchema,
  storage: StorageConfigSchema,
  workspace: WorkspaceConfigSchema,
  worker: z.object({
    /** 注册表里的唯一 id；多副本时必须唯一（默认 hostname-pid） */
    id: z.string().min(1).default(`${hostname()}-${process.pid}`),
    /** gateway 直连地址（k8s 下用 Pod IP 或 Service；本地默认 loopback） */
    endpoint: z.string().url().default('http://127.0.0.1:9994'),
    /** gateway / worker 之间的内部令牌；生产必须显式配置 */
    internalToken: z.string().min(1).default('dev-tool-token'),
    /** 能力网关地址；配了才向网关登记能力（本地不配也能跑） */
    gatewayUrl: z.string().url().optional(),
    /** 心跳间隔：注册表 freshness 用 */
    heartbeatIntervalMs: z.coerce.number().int().positive().default(10_000),
    /** 本 worker 同时执行的上限（注册表里的 active 是近似值） */
    maxConcurrency: z.coerce.number().int().positive().default(8),
    /** 会话临时目录的根（本地盘可丢弃；真相在工作区对象存储） */
    workspaceRoot: z.string().min(1).default(join(tmpdir(), 'billy-common-capability')),
    /** 单条命令默认 / 硬上限 */
    commandTimeoutMs: z.coerce.number().int().positive().default(300_000),
    /** 每条流（stdout / stderr）的输出上限 */
    maxOutputBytes: z.coerce
      .number()
      .int()
      .positive()
      .default(64 * 1024),
    /** web-fetch 的部署级配置；worker 不读 DB，先用 env 兜住 */
    web: z
      .object({
        timeoutMs: z.coerce.number().int().positive().default(20_000),
        maxBytes: z.coerce
          .number()
          .int()
          .positive()
          .default(2 * 1024 * 1024),
        pageLines: z.coerce.number().int().positive().default(1000),
        cacheTtlMs: z.coerce
          .number()
          .int()
          .positive()
          .default(30 * 60_000),
        allowPrivateNetwork: z.coerce.boolean().default(false),
        userAgent: z.string().min(1).optional(),
      })
      .default({
        timeoutMs: 20_000,
        maxBytes: 2 * 1024 * 1024,
        pageLines: 1000,
        cacheTtlMs: 30 * 60_000,
        allowPrivateNetwork: false,
      }),
  }),
})

export type ToolWorkerAppConfig = z.infer<typeof toolWorkerAppConfigSchema>

/** 业务层注入 token（只含 worker 分片） */
export const ToolWorkerConfig = Symbol.for('ToolWorkerConfig')
export type ToolWorkerConfigValue = ToolWorkerAppConfig['worker']

const optional = (value: string | undefined): string | undefined =>
  value === undefined || value === '' ? undefined : value

const parseBoolean = (value: string | undefined): boolean | undefined =>
  value === undefined || value === '' ? undefined : value !== 'false'

/** 环境变量 → 嵌套配置（只声明映射，校验 / 默认值由 schema 负责） */
export const mapToolWorkerEnv = (env: NodeJS.ProcessEnv): Record<string, unknown> => ({
  server: {
    port: optional(env.TOOL_WORKER_PORT) ?? optional(env.PORT),
  },
  logger: {
    prefix: optional(env.LOG_PREFIX) ?? 'common-capability',
    level: optional(env.LOG_LEVEL),
    pretty: parseBoolean(env.LOG_PRETTY),
  },
  redis: {
    url: optional(env.REDIS_URL),
    keyPrefix: optional(env.REDIS_KEY_PREFIX),
  },
  db: {
    url: optional(env.TOOL_WORKER_DB_URL) ?? optional(env.DB_URL),
    poolSize: optional(env.DB_POOL_SIZE),
  },
  storage: {
    provider: optional(env.OBJECT_STORAGE_PROVIDER),
    region: optional(env.OBJECT_STORAGE_REGION),
    bucket: optional(env.OBJECT_STORAGE_BUCKET),
    accessKeyId: optional(env.OBJECT_STORAGE_ACCESS_KEY_ID),
    secretAccessKey: optional(env.OBJECT_STORAGE_SECRET_ACCESS_KEY),
    endpoint: optional(env.OBJECT_STORAGE_ENDPOINT),
  },
  workspace: {
    mode: optional(env.AGENT_WORKSPACE_MODE),
    sandboxNetwork: optional(env.AGENT_WORKSPACE_SANDBOX_NETWORK),
    probeTimeoutMs: optional(env.AGENT_WORKSPACE_PROBE_TIMEOUT_MS),
  },
  worker: {
    id: optional(env.TOOL_WORKER_ID),
    endpoint: optional(env.TOOL_WORKER_ENDPOINT),
    internalToken: optional(env.TOOL_INTERNAL_TOKEN),
    gatewayUrl: optional(env.CAPABILITY_GATEWAY_URL) ?? optional(env.TOOL_GATEWAY_URL),
    heartbeatIntervalMs: optional(env.TOOL_WORKER_HEARTBEAT_MS),
    maxConcurrency: optional(env.TOOL_WORKER_MAX_CONCURRENCY),
    workspaceRoot: optional(env.TOOL_WORKER_WORKSPACE_ROOT),
    commandTimeoutMs: optional(env.TOOL_WORKER_COMMAND_TIMEOUT_MS),
    maxOutputBytes: optional(env.TOOL_WORKER_MAX_OUTPUT_BYTES),
    web: {
      timeoutMs: optional(env.TOOL_WEB_FETCH_TIMEOUT_MS),
      maxBytes: optional(env.TOOL_WEB_FETCH_MAX_BYTES),
      pageLines: optional(env.TOOL_WEB_FETCH_PAGE_LINES),
      cacheTtlMs: optional(env.TOOL_WEB_FETCH_CACHE_TTL_MS),
      allowPrivateNetwork: parseBoolean(env.TOOL_WEB_FETCH_ALLOW_PRIVATE_NETWORK),
      userAgent: optional(env.TOOL_WEB_FETCH_USER_AGENT),
    },
  },
})

export const loadToolWorkerAppConfig = (): Promise<ToolWorkerAppConfig> =>
  AppConfigFacade.initial({
    schema: toolWorkerAppConfigSchema,
    loader: envConfigLoader({ envFileName: '.env', mapEnv: mapToolWorkerEnv }),
  })
