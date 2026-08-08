import { AccessToken, verifyToken } from '@repo/core';
import { AppErrorCodes, ResponseUtils } from '@repo/shared';
import { Context, Effect, Layer } from 'effect';
import { getCookie } from 'hono/cookie';
import { createMiddleware } from 'hono/factory';
import { EffectExecutor } from './effect-executor.js';
import { describeErrorCode } from './http.js';
import { RequestContextStorage } from './request-context.js';

export interface AuthenticationApi {
  readonly requireAuth: ReturnType<typeof createMiddleware>;
}

export class Authentication extends Context.Tag('app/Authentication')<
  Authentication,
  AuthenticationApi
>() {}

export const AuthenticationLive = Layer.effect(
  Authentication,
  Effect.gen(function* () {
    const executor = yield* EffectExecutor;
    const requestContext = yield* RequestContextStorage;
    const requireAuth = createMiddleware(async (context, next) => {
      const authorization = context.req.header('Authorization');
      const token = authorization?.startsWith('Bearer ')
        ? authorization.slice(7)
        : getCookie(context, 'access-token');

      if (!token) {
        const error = describeErrorCode(AppErrorCodes.Unauthorized);
        return context.json(
          ResponseUtils.error(error.value, error.label),
          error.http,
        );
      }

      try {
        const userId = await executor.run(
          verifyToken(new AccessToken({ token })),
        );
        requestContext.set('userId', userId);
        await next();
      } catch {
        const error = describeErrorCode(AppErrorCodes.TokenInvalid);
        return context.json(
          ResponseUtils.error(error.value, error.label),
          error.http,
        );
      }
    });
    return { requireAuth };
  }),
);
