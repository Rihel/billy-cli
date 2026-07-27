import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  BadRequestException,
} from '@nestjs/common'
import { AppLoggerService } from '../logger/logger.service.js'
import { AppError } from '../errors.js'
import { ResponseUtils, parseZodIssues } from '@repo/shared'

@Catch()
export class AppExceptionFilter implements ExceptionFilter {
  constructor(private readonly logger: AppLoggerService) {
    this.logger.setContext(AppExceptionFilter.name)
  }

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp()
    const response = ctx.getResponse<any>()

    // Zod 校验错误：提取中文提示，返回 HTTP 200
    if (
      exception instanceof BadRequestException &&
      exception.cause &&
      typeof exception.cause === 'object' &&
      'issues' in (exception.cause as any)
    ) {
      const cause = exception.cause as {
        issues: Array<{
          code: string
          path: (string | number)[]
          message: string
        }>
      }
      const message = parseZodIssues(cause.issues as any)
      this.logger.warn('参数校验异常', { message, issues: cause.issues })
      response.status(200).json(ResponseUtils.error(400, message))
      return
    }

    if (exception instanceof AppError) {
      this.logger.warn('业务异常', { code: exception.errorCode, message: exception.message })
      response
        .status(exception.httpStatus)
        .json(ResponseUtils.error(exception.errorCode, exception.message))
      return
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus()
      this.logger.warn('HTTP 异常', { status, message: exception.message })
      response
        .status(status)
        .json(ResponseUtils.error(status, exception.message))
      return
    }

    if (exception instanceof Error) {
      this.logger.error('系统异常', { message: exception.message, stack: exception.stack })
      response.status(500).json(ResponseUtils.error(5001, '系统错误'))
      return
    }

    this.logger.error('未知异常', { type: typeof exception })
    response.status(500).json(ResponseUtils.error(5001, '未知错误'))
  }
}
