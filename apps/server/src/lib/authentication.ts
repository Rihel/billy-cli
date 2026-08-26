import { AdminService, AuthService } from '@repo/core';
import type { AppContext } from '@repo/di';
import { AppErrorCodes, ResponseUtils } from '@repo/shared';
import { getCookie } from 'hono/cookie';
import { createMiddleware } from 'hono/factory';
import type { Context } from 'hono';
import { describeErrorCode } from './http.js';
import { requestContext } from './request-context.js';

/** 从 Authorization: Bearer 或 access-token cookie 提取 token */
export const extractToken = (context: Context): string | undefined => {
  const authorization = context.req.header('Authorization');
  return authorization?.startsWith('Bearer ')
    ? authorization.slice(7)
    : getCookie(context, 'access-token');
};

const unauthorized = (context: Context) => {
  const error = describeErrorCode(AppErrorCodes.Unauthorized);
  return context.json(
    ResponseUtils.error(error.value, error.label),
    error.http,
  );
};

const tokenInvalid = (context: Context) => {
  const error = describeErrorCode(AppErrorCodes.TokenInvalid);
  return context.json(
    ResponseUtils.error(error.value, error.label),
    error.http,
  );
};

/** 前台用户鉴权：校验用户 token，把 userId 注入请求上下文 */
export const makeRequireAuth = (runtime: AppContext) =>
  createMiddleware(async (context, next) => {
    const token = extractToken(context);

    if (!token) {
      return unauthorized(context);
    }

    try {
      const authService = runtime.get(AuthService);
      const userId = await authService.verifyToken({ token });
      requestContext.set('userId', userId);
      await next();
    } catch {
      return tokenInvalid(context);
    }
  });

/** 后台管理员鉴权：校验管理员 token（type='admin'），把 adminId 注入请求上下文 */
export const makeRequireAdminAuth = (runtime: AppContext) =>
  createMiddleware(async (context, next) => {
    const token = extractToken(context);

    if (!token) {
      return unauthorized(context);
    }

    try {
      const adminService = runtime.get(AdminService);
      const adminId = await adminService.verifyToken({ token });
      requestContext.set('adminId', adminId);
      await next();
    } catch {
      return tokenInvalid(context);
    }
  });
