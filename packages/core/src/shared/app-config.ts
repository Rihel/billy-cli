import type { ObjectStorageConfig } from './object-storage/types.js'
import type { RuntimeConfigInput } from './runtime-config.js'

/** 应用配置：从输入对象派生各能力所需的配置项。 */
export class AppConfig {
  constructor(readonly input: RuntimeConfigInput) {}

  get isDev(): boolean {
    return this.input.isDev ?? false
  }

  get port(): number {
    return this.input.port ?? 9989
  }

  get dbUrl(): string {
    return this.input.db.url
  }

  get redisUrl(): string {
    return this.input.redis?.url ?? 'redis://localhost:6379/0'
  }

  get redisKeyPrefix(): string | undefined {
    return this.input.redis?.keyPrefix
  }

  get jwtSecret(): string {
    return this.input.jwt.secret
  }

  get jwtExpiresIn(): string {
    return this.input.jwt.expiresIn ?? '7d'
  }

  get resetPasswordTokenTtlMinutes(): number {
    return this.input.auth?.resetPasswordTokenTtlMinutes ?? 30
  }

  get passwordHashRounds(): number {
    return this.input.auth?.passwordHashRounds ?? 10
  }

  get objectStorageConfig(): ObjectStorageConfig {
    const s = this.input.objectStorage
    return {
      provider: s.provider ?? 's3',
      region: s.region ?? 'us-east-1',
      bucket: s.bucket,
      accessKeyId: s.accessKeyId,
      secretAccessKey: s.secretAccessKey,
      endpoint: s.endpoint,
    }
  }

  get loggerName(): string {
    return this.input.logger?.name ?? 'app'
  }

  get loggerPretty(): boolean {
    return this.input.logger?.pretty ?? false
  }
}
