import { Effect } from 'effect'
import { AppErrorCodes } from '@repo/shared'
import type { ZodError, ZodSchema } from 'zod'
import { makeError, type AppError } from '../errors.js'

/** 用 Zod schema 校验入参，失败时转换为 AppError (InvalidInput) */
export function parseInput<T>(
  schema: ZodSchema<T>,
  input: unknown,
): Effect.Effect<T, AppError> {
  return Effect.try({
    try: () => schema.parse(input),
    catch: (e) => {
      const zodErr = e as ZodError
      const message = zodErr?.issues?.length
        ? zodErr.issues.map((i) => i.message).join('; ')
        : String(e)
      return makeError(AppErrorCodes.InvalidInput, message)
    },
  })
}
