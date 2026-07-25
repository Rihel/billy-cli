import { Injectable } from '@nestjs/common';
import { AppErrorCodes } from '@repo/shared';
import type { TRPCMiddleware, MiddlewareOptions } from 'nestjs-trpc';
import { AppError } from '../errors.js';

@Injectable()
export class AuthMiddleware implements TRPCMiddleware {
  use(opts: MiddlewareOptions<{ userId?: string }>) {
    const { ctx, next } = opts;
    if (!ctx.userId) {
      throw new AppError(AppErrorCodes.Unauthorized);
    }
    return next({ ctx: { ...ctx, userId: ctx.userId } });
  }
}
