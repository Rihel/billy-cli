import { Injectable } from '@nestjs/common';
import { TRPCError } from '@trpc/server';
import type { TRPCMiddleware, MiddlewareOptions } from 'nestjs-trpc';

@Injectable()
export class AuthMiddleware implements TRPCMiddleware {
  use(opts: MiddlewareOptions<{ userId?: string }>) {
    const { ctx, next } = opts;
    if (!ctx.userId) {
      throw new TRPCError({ code: 'UNAUTHORIZED', message: '请先登录' });
    }
    return next({ ctx: { ...ctx, userId: ctx.userId } });
  }
}
