import { AppError } from '@repo/kits'
import { AppErrorCodes } from '@repo/shared'

/** 记忆不存在（或不属于当前用户；不区分两者，避免探测） */
export class MemoryNotFoundError extends AppError {
  readonly code = AppErrorCodes.MemoryNotFound
  constructor(readonly memoryId: string) {
    super(`记忆不存在: ${memoryId}`)
  }
}

/** 每用户条数已达上限 */
export class MemoryLimitExceededError extends AppError {
  readonly code = AppErrorCodes.MemoryLimitExceeded
  constructor(readonly limit: number) {
    super(`记忆条数已达上限: ${limit}`)
  }
}

/** 记忆内容不合法（空 / 超长） */
export class MemoryContentInvalidError extends AppError {
  readonly code = AppErrorCodes.MemoryContentInvalid
  constructor(readonly reason: string) {
    super(`记忆内容不合法: ${reason}`)
  }
}
