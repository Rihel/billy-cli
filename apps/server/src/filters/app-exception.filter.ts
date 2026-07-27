import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
} from '@nestjs/common';
import { Response } from 'express';
import { AppError, AppLoggerService } from '@repo/kits';
import { ResponseUtils } from '@repo/shared';

@Catch()
export class AppExceptionFilter implements ExceptionFilter {
  constructor(private readonly logger: AppLoggerService) {
    this.logger.setContext(AppExceptionFilter.name);
  }

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    if (exception instanceof AppError) {
      this.logger.warn(`【业务异常】code=${exception.errorCode} message=${exception.message}`);
      response.status(exception.httpStatus).json(
        ResponseUtils.error(exception.errorCode, exception.message),
      );
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      this.logger.warn(`【HTTP 异常】status=${status} message=${exception.message}`);
      response.status(status).json(
        ResponseUtils.error(status, exception.message),
      );
      return;
    }

    if (exception instanceof Error) {
      this.logger.error(`【系统异常】${exception.message}`);
      response.status(500).json(
        ResponseUtils.error(5001, '系统错误'),
      );
      return;
    }

    this.logger.error('【未知异常】未捕获的异常类型');
    response.status(500).json(ResponseUtils.error(5001, '未知错误'));
  }
}
