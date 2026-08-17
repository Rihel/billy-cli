import _ from 'lodash'
import { z } from 'zod'

/**
 * 应用配置 schema：按能力分组命名空间（db / redis / jwt / auth / objectStorage / logger），
 * 默认值单一事实源，由 createAppConfig 从环境变量解析。
 */
export const AppConfigSchema = z.object({
  env: z.enum(['development', 'production']).default('development'),
  port: z.coerce.number().default(9989),
  db: z.object({
    url: z
      .string()
      .default('postgres://postgres:postgres@localhost:5432/postgres'),
    sync: z.boolean().default(false),
  }),
  redis: z.object({
    url: z.string().default('redis://localhost:6379/0'),
    keyPrefix: z.string().optional(),
  }),
  jwt: z.object({
    secret: z.string().default('default-secret-change-in-production'),
    expiresIn: z.string().default('7d'),
  }),
  auth: z.object({
    resetPasswordTokenTtlMinutes: z.coerce.number().default(30),
    passwordHashRounds: z.coerce.number().default(10),
  }),
  objectStorage: z.object({
    provider: z.enum(['s3', 'cos']).default('s3'),
    region: z.string().default('us-east-1'),
    bucket: z.string().default('billy-cli'),
    accessKeyId: z.string().default('minioadmin'),
    secretAccessKey: z.string().default('minioadmin'),
    endpoint: z.string().default('http://localhost:9000'),
  }),
  logger: z.object({
    name: z.string().default('app'),
    pretty: z.boolean().default(false),
  }),
})

/** 解析后的配置类型（注入组件的类型） */
export type AppConfig = z.infer<typeof AppConfigSchema>

/** 可传入的覆盖输入（允许部分字段，未传的用默认值） */
export type AppConfigInput = Partial<z.input<typeof AppConfigSchema>>

/** inversify 注入 token（AppConfig 是纯类型，用 Symbol 作运行时标识） */
export const AppConfig = Symbol.for('AppConfig')

const fromEnv = (env: Record<string, string | undefined>) => ({
  env: env.NODE_ENV === 'production' ? 'production' : 'development',
  port: env.PORT,
  db: {
    url: env.DB_URL,
  },
  redis: { url: env.REDIS_URL, keyPrefix: env.REDIS_KEY_PREFIX },
  jwt: { secret: env.JWT_SECRET, expiresIn: env.JWT_EXPIRES_IN },
  auth: {
    resetPasswordTokenTtlMinutes: env.RESET_PASSWORD_TOKEN_TTL_MINUTES,
    passwordHashRounds: env.PASSWORD_HASH_ROUNDS,
  },
  objectStorage: {
    provider: env.OBJECT_STORAGE_PROVIDER,
    region: env.OBJECT_STORAGE_REGION,
    bucket: env.OBJECT_STORAGE_BUCKET,
    accessKeyId: env.OBJECT_STORAGE_ACCESS_KEY_ID,
    secretAccessKey: env.OBJECT_STORAGE_SECRET_ACCESS_KEY,
    endpoint: env.OBJECT_STORAGE_ENDPOINT,
  },
  logger: {
    name: env.LOGGER_NAME,
    // 未显式配置 LOGGER_PRETTY 时：开发环境默认 pretty，生产默认 JSON
    pretty:
      env.LOGGER_PRETTY === undefined
        ? env.NODE_ENV !== 'production'
        : env.LOGGER_PRETTY === 'true',
  },
})

/**
 * 从环境变量构建配置（带默认值），overrides 可覆盖任意分组/字段。
 */
export const createAppConfig = (
  env: Record<string, string | undefined> = process.env,
  overrides: AppConfigInput = {},
): AppConfig => AppConfigSchema.parse(_.merge(fromEnv(env), overrides))
