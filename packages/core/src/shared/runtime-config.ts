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
