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

/**
 * 批量操作部分失败（`db/batch.ts`）。
 *
 * 分片并发执行时可能只有部分分片失败，这里把失败项聚合抛出：
 * 既保住「整体不静默成功」的语义，又让调用方能拿到每个分片的失败原因。
 */
export class BatchOperationError extends AppError {
  readonly code = AppErrorCodes.Internal
  constructor(
    /** 失败分片数 */
    readonly failedChunks: number,
    /** 各失败分片的原始异常 */
    readonly failures: unknown[],
  ) {
    const first = failures[0]
    super(
      `Batch operation failed: ${failedChunks} chunk(s) failed${first ? `, first: ${String(first)}` : ''}`,
    )
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

export class PubSubError extends AppError {
  readonly code = AppErrorCodes.Internal
  constructor(readonly cause: unknown) {
    super('Pub/sub operation failed')
  }
}

export class EventBusError extends AppError {
  readonly code = AppErrorCodes.Internal
  constructor(readonly cause: unknown) {
    super('Event bus operation failed')
  }
}
