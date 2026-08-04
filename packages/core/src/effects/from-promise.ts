import { Effect } from 'effect'
import { AppErrorCodes } from '@repo/shared'
import { makeError, type AppError } from '../errors.js'

/** 将 Promise-based 基础设施操作包装为 Effect，失败时转换为 Internal AppError */
export function fromPromise<A>(
  operation: () => PromiseLike<A>,
  message: string,
): Effect.Effect<A, AppError> {
  return Effect.tryPromise({
    try: operation,
    catch: (cause) => {
      const detail = cause instanceof Error ? cause.message : String(cause)
      return makeError(AppErrorCodes.Internal, `${message}: ${detail}`)
    },
  })
}
