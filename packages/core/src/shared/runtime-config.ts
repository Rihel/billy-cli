import { ConfigProvider, Layer } from 'effect'

export interface RuntimeConfig {
  isDev?: boolean
  port?: number
  db: { url: string }
  redis?: { url?: string; keyPrefix?: string }
  jwt: { secret: string; expiresIn?: string }
  auth?: {
    resetPasswordTokenTtlMinutes?: number
    passwordHashRounds?: number
  }
  objectStorage: {
    provider?: 's3' | 'cos'
    region?: string
    bucket: string
    accessKeyId: string
    secretAccessKey: string
    endpoint?: string
  }
  logger?: { name?: string; pretty?: boolean }
}

export type RuntimeConfigInput = RuntimeConfig

const put = (values: Map<string, string>, key: string, value: unknown) => {
  if (value !== undefined) values.set(key, String(value))
}

export const makeConfigProvider = (input: RuntimeConfigInput) => {
  const values = new Map<string, string>()
  const objectStorage = input.objectStorage

  put(values, 'NODE_ENV', input.isDev === false ? 'production' : 'development')
  put(values, 'PORT', input.port)
  put(values, 'DB_URL', input.db.url)
  put(values, 'REDIS_URL', input.redis?.url)
  put(values, 'REDIS_KEY_PREFIX', input.redis?.keyPrefix)
  put(values, 'JWT_SECRET', input.jwt.secret)
  put(values, 'JWT_EXPIRES_IN', input.jwt.expiresIn)
  put(
    values,
    'RESET_PASSWORD_TOKEN_TTL_MINUTES',
    input.auth?.resetPasswordTokenTtlMinutes,
  )
  put(values, 'PASSWORD_HASH_ROUNDS', input.auth?.passwordHashRounds)
  put(values, 'OBJECT_STORAGE_PROVIDER', objectStorage.provider)
  put(values, 'OBJECT_STORAGE_REGION', objectStorage.region)
  put(values, 'OBJECT_STORAGE_BUCKET', objectStorage.bucket)
  put(values, 'OBJECT_STORAGE_ACCESS_KEY_ID', objectStorage.accessKeyId)
  put(values, 'OBJECT_STORAGE_SECRET_ACCESS_KEY', objectStorage.secretAccessKey)
  put(values, 'OBJECT_STORAGE_ENDPOINT', objectStorage.endpoint)
  put(values, 'LOGGER_NAME', input.logger?.name)
  put(values, 'LOGGER_PRETTY', input.logger?.pretty)

  return ConfigProvider.fromMap(values)
}

export const makeConfigLayer = (input: RuntimeConfigInput) =>
  Layer.setConfigProvider(makeConfigProvider(input))
