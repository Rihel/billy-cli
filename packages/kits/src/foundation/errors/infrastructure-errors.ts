import { AppErrorCodes } from '@repo/shared'
import { AppError } from './app-error.js'

/** 基础设施错误：数据库、Redis、密码哈希、Token、对象存储产生的异常。 */
export class PasswordHashingError extends AppError {
  readonly code = AppErrorCodes.Internal
  constructor(readonly cause: unknown) {
    super('Password hashing failed')
  }
}

export class TokenSigningError extends AppError {
  readonly code = AppErrorCodes.Internal
  constructor(readonly cause: unknown) {
    super('Token signing failed')
  }
}

export class RedisStoreError extends AppError {
  readonly code = AppErrorCodes.Internal
  constructor(readonly cause: unknown) {
    super('Redis store operation failed')
  }
}

/**
 * 分布式锁获取失败（等待超时）。
 * 语义是「资源被占用，稍后重试」，故映射到 RateLimited（4002 / HTTP 429）。
 */
export class RedisLockError extends AppError {
  readonly code = AppErrorCodes.RateLimited
  constructor(readonly key: string) {
    super(`Redis lock acquire timeout: ${key}`)
  }
}

export class QueueError extends AppError {
  readonly code = AppErrorCodes.Internal
  constructor(readonly cause: unknown) {
    super('Queue operation failed')
  }
}

export class SchedulerError extends AppError {
  readonly code = AppErrorCodes.Internal
  constructor(readonly cause: unknown) {
    super('Scheduler operation failed')
  }
}

export class ObjectStorageError extends AppError {
  readonly code = AppErrorCodes.Internal
  constructor(
    readonly operation: string,
    readonly cause: unknown,
  ) {
    super(`Object storage operation failed: ${operation}`)
  }
}

export class StreamHubError extends AppError {
  readonly code = AppErrorCodes.Internal
  constructor(readonly cause: unknown) {
    super('SSE hub operation failed')
  }
}
