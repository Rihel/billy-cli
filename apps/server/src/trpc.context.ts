import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { TRPCContext } from 'nestjs-trpc';
import { parseCookie } from 'cookie';
import { CreateExpressContextOptions } from '@trpc/server/adapters/express';
import { z } from 'zod';

export const ContextData = z.object({
  userId: z.string(),
});

@Injectable()
export class TrpcAppContext implements TRPCContext {
  constructor(private jwt: JwtService) {}

  create(opts: CreateExpressContextOptions): Record<string, unknown> {
    const req = opts.req;

    // 优先从 Authorization header 取，其次从 cookie access-token 取
    const authHeader = req.headers.authorization;
    let rawToken: string | undefined;

    if (authHeader?.startsWith('Bearer ')) {
      rawToken = authHeader.slice(7);
    } else {
      const cookieStr = req.headers.cookie;
      if (cookieStr) {
        rawToken = parseCookie(cookieStr)['access-token'];
      }
    }

    let userId: string | undefined;
    if (rawToken) {
      try {
        const payload = this.jwt.verify<{ sub: string }>(rawToken);
        userId = payload.sub;
      } catch {
        // invalid token → userId stays undefined
      }
    }
    return { userId };
  }
}
