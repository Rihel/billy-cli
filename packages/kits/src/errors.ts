import { HttpStatus } from '@nestjs/common'
import { AppErrorCodes } from '@repo/shared'

export class AppError extends Error {
  readonly errorCode: number
  readonly httpStatus: HttpStatus

  constructor(code: number, message?: string) {
    const option = AppErrorCodes.getOption(code)
    super(message ?? option.label)
    this.errorCode = option.value
    this.httpStatus = option.http
    this.name = 'AppError'
  }
}
