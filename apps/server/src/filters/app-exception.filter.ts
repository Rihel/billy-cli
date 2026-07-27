import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
} from '@nestjs/common';
import { Response } from 'express';
import { AppError } from '@repo/kits';
import { ResponseUtils } from '@repo/shared';

@Catch()
export class AppExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    if (exception instanceof AppError) {
      response.status(exception.httpStatus).json(
        ResponseUtils.error(exception.errorCode, exception.message),
      );
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      response.status(status).json(
        ResponseUtils.error(status, exception.message),
      );
      return;
    }

    if (exception instanceof Error) {
      response.status(500).json(
        ResponseUtils.error(5001, '系统错误', exception.message),
      );
      return;
    }

    response.status(500).json(ResponseUtils.error(5001, '未知错误'));
  }
}
