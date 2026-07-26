import { HttpStatus } from '@nestjs/common'
import { AppErrorCodes } from '@repo/shared'
import { TRPCError } from '@trpc/server'

export class AppError extends TRPCError {
  readonly errorCode: number
  readonly httpStatus: HttpStatus

  constructor(code: number, message?: string) {
    const option = AppErrorCodes.getOption(code)
    super({ code: option.trpc, message: message ?? option.label })
    this.errorCode = option.value
    this.httpStatus = option.http
    this.name = 'AppError'
  }
}
