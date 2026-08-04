import { Effect } from 'effect'
import { AppErrorCodes } from '@repo/shared'
import { makeError, type AppError } from '../errors.js'

export function tryInfra<A>(
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
