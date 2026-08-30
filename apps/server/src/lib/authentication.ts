import { AdminService } from '../modules/admin/index.js';
import { AuthService } from '../modules/auth/index.js';
import { ServerConfig, type ServerConfig as ServerConfigType } from '../config.js';
import type { AppContext } from '@repo/di';
import { AppErrorCodes, ResponseUtils } from '@repo/shared';
import { getCookie } from 'hono/cookie';
import { createMiddleware } from 'hono/factory';
import type { Context } from 'hono';
import { describeErrorCode } from './http.js';
import { requestContext } from './request-context.js';

/** 读取用户体系开关；关闭时守卫直接放行（返回 true 表示应跳过鉴权）。 */
const isAuthDisabled = (runtime: AppContext): boolean =>
  !runtime.get<ServerConfigType>(ServerConfig).authEnabled;

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
    // 用户体系开关关闭：直接放行，不校验 token
    if (isAuthDisabled(runtime)) {
      return next();
    }

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
    // 用户体系开关关闭：直接放行，不校验 token
    if (isAuthDisabled(runtime)) {
      return next();
    }

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
