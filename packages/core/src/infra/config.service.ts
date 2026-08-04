import { Context, Effect, Layer } from 'effect'
import { z } from 'zod'

// ── Schema ───────────────────────────────────────────────────────────────────

export const StorageConfigSchema = z.object({
  provider: z.enum(['s3', 'cos']).default('s3'),
  region: z.string().default('us-east-1'),
  bucket: z.string().min(1),
  accessKeyId: z.string().min(1),
  secretAccessKey: z.string().min(1),
  endpoint: z.string().optional(),
})

export const AppConfigSchema = z.object({
  isDev: z.boolean().default(true),
  port: z.coerce.number().int().min(1).max(65535).default(9989),
  db: z.object({
    url: z.string().min(1, 'db.url is required'),
  }),
  redis: z
    .object({
      url: z.string().default('redis://localhost:6379/0'),
      keyPrefix: z.string().optional(),
    })
    .prefault({}),
  jwt: z.object({
    secret: z.string().min(8, 'jwt.secret must be at least 8 characters'),
    expiresIn: z.string().default('7d'),
  }),
  auth: z
    .object({
      resetPasswordTokenTtlMinutes: z.number().int().positive().default(30),
      passwordHashRounds: z.coerce.number().int().min(4).max(31).default(10),
    })
    .prefault({}),
  storage: StorageConfigSchema,
  logger: z
    .object({
      name: z.string().optional(),
      pretty: z.boolean().optional(),
    })
    .default({}),
})

export type AppConfig = z.infer<typeof AppConfigSchema>
export type AppConfigInput = z.input<typeof AppConfigSchema>

// ── Tag ──────────────────────────────────────────────────────────────────────

export class ConfigService extends Context.Tag('ConfigService')<
  ConfigService,
  AppConfig
>() {}

// ── Factories ────────────────────────────────────────────────────────────────

/**
 * Build a ConfigService layer from any plain object (hardcoded or assembled
 * from process.env). Zod validates required fields and fills in defaults.
 *
 * @example Hardcoded
 * makeConfigLayer({ db: { url: 'postgres://...' }, jwt: { secret: 'secret' }, storage: { ... } })
 *
 * @example Env-based
 * makeConfigLayer({ db: { url: process.env.DB_URL }, jwt: { secret: process.env.JWT_SECRET }, storage: { ... } })
 */
export const makeConfigLayer = (
  input: AppConfigInput,
): Layer.Layer<ConfigService, Error> =>
  Layer.effect(
    ConfigService,
    Effect.try({
      try: () => AppConfigSchema.parse(input),
      catch: (e) => new Error(`[Config] Validation failed:\n${e}`),
    }),
  )

/**
 * Default env-reading config layer.
 * Set required env vars: DB_URL, JWT_SECRET, STORAGE_BUCKET,
 * STORAGE_ACCESS_KEY_ID, STORAGE_SECRET_ACCESS_KEY.
 */
export const ConfigServiceLive: Layer.Layer<ConfigService, Error> =
  makeConfigLayer({
    isDev: process.env.NODE_ENV !== 'production',
    port: process.env.PORT ? Number(process.env.PORT) : undefined,
    db: {
      url: process.env.DB_URL ?? '',
    },
    redis: {
      url: process.env.REDIS_URL ?? 'redis://localhost:6379/0',
      keyPrefix: process.env.REDIS_KEY_PREFIX ?? 'app:',
    },
    jwt: {
      secret: process.env.JWT_SECRET ?? '',
      expiresIn: process.env.JWT_EXPIRES_IN ?? '7d',
    },
    auth: {
      resetPasswordTokenTtlMinutes: 30,
      passwordHashRounds: process.env.PASSWORD_HASH_ROUNDS ?? 10,
    },
    storage: {
      provider: (process.env.STORAGE_PROVIDER as 's3' | 'cos') ?? 's3',
      region: process.env.STORAGE_REGION ?? 'us-east-1',
      bucket: process.env.STORAGE_BUCKET ?? '',
      accessKeyId: process.env.STORAGE_ACCESS_KEY_ID ?? '',
      secretAccessKey: process.env.STORAGE_SECRET_ACCESS_KEY ?? '',
      endpoint: process.env.STORAGE_ENDPOINT,
    },
  })
