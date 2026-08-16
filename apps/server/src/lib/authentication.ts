import { AuthService, appCore } from '@repo/core';
import { AppErrorCodes, ResponseUtils } from '@repo/shared';
import { getCookie } from 'hono/cookie';
import { createMiddleware } from 'hono/factory';
import { describeErrorCode } from './http.js';
import { requestContext } from './request-context.js';

export const requireAuth = createMiddleware(async (context, next) => {
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
    const authService = appCore.get(AuthService);
    const userId = await authService.verifyToken({ token });
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
