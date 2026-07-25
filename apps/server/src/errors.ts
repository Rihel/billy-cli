import { TRPCError } from '@trpc/server';
import type { TRPC_ERROR_CODE_KEY } from '@trpc/server/rpc';

import { AppErrorCodes } from '@repo/shared';
import { HttpStatus } from '@nestjs/common';

/**
 * 传输无关的业务异常。
 *
 * - **tRPC**：`AppError extends TRPCError`，tRPC 原生识别，无需任何适配层。
 * - **REST**：在 ExceptionFilter 中 catch `AppError`，使用 `httpStatus` / `errorCode` 返回响应：
 *   ```ts
 *   @Catch(AppError)
 *   export class AppErrorFilter implements ExceptionFilter {
 *     catch(err: AppError, host: ArgumentsHost) {
 *       host.switchToHttp().getResponse()
 *         .status(err.httpStatus)
 *         .json({ code: err.errorCode, message: err.message });
 *     }
 *   }
 *   ```
 */
export class AppError extends TRPCError {
  /** 数字业务码，对外暴露给客户端 */
  public readonly errorCode: number;
  /** HTTP 状态码，供 REST 传输层使用 */
  public readonly httpStatus: HttpStatus;

  constructor(code: number, message?: string) {
    const option = AppErrorCodes.getOption(code);
    super({ code: option.trpc, message: message ?? option.label });
    this.errorCode = option.value;
    this.httpStatus = option.http;
    this.name = 'AppError';
  }
}
