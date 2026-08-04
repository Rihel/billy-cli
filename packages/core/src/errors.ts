import { Data } from 'effect'
import { AppErrorCodes } from '@repo/shared'

export class AppError extends Data.TaggedError('AppError')<{
  code: number
  message: string
  httpStatus: number
}> {}

export function makeError(code: number, message?: string): AppError {
  const option = AppErrorCodes.getOption(code)
  return new AppError({
    code,
    message: message ?? option?.label ?? 'Unknown error',
    httpStatus: option?.http ?? 500,
  })
}
