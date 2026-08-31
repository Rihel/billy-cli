import { AuthService } from '../modules/auth/index.js';
import type { AppContext } from '@repo/di';
import {
  ChangePasswordSchema,
  ForgotPasswordSchema,
  LoginSchema,
  RegisterSchema,
  ResetPasswordSchema,
  UpdateInfoSchema,
} from '@repo/shared';
import { Hono } from 'hono';
import {
  extractToken,
  makeRequireAuth,
} from '../lib/authentication.js';
import { jsonBody, success } from '../lib/http.js';
import { makeRateLimit } from '../lib/rate-limit.js';
import { requestContext } from '../lib/request-context.js';

const currentUserId = (): string => {
  const userId = requestContext.get('userId');
  if (!userId) {
    throw new Error('Authenticated request context is unavailable');
  }
  return userId;
};

export const makeAuthRoutes = (runtime: AppContext) => {
  const authService = runtime.get(AuthService);
  const requireAuth = makeRequireAuth(runtime);
  // 敏感接口限流（按 IP 固定窗口，白名单豁免；防暴力破解 / 撞库）
  const loginRateLimit = makeRateLimit(runtime, { scope: 'login' });
  const registerRateLimit = makeRateLimit(runtime, { scope: 'register' });
  const forgotPasswordRateLimit = makeRateLimit(runtime, {
    scope: 'forgot-password',
  });
  const resetPasswordRateLimit = makeRateLimit(runtime, {
    scope: 'reset-password',
  });
  const routes = new Hono();

  routes
    .post(
      '/register',
      registerRateLimit,
      jsonBody(RegisterSchema),
      async (context) => {
        const input = context.req.valid('json');
        return success(context, await authService.register(input));
      },
    )
    .post('/login', loginRateLimit, jsonBody(LoginSchema), async (context) => {
      const input = context.req.valid('json');
      return success(context, await authService.login(input));
    })
    // 登出幂等：token 有效则撤销会话，无效也返回成功（不要求登录态）
    .post('/logout', async (context) => {
      const token = extractToken(context);
      if (token) {
        return success(context, await authService.logout({ token }));
      }
      return success(context, { success: true });
    })
    .post(
      '/forgot-password',
      forgotPasswordRateLimit,
      jsonBody(ForgotPasswordSchema),
      async (context) => {
        const input = context.req.valid('json');
        return success(context, await authService.forgotPassword(input));
      },
    )
    .post(
      '/reset-password',
      resetPasswordRateLimit,
      jsonBody(ResetPasswordSchema),
      async (context) => {
        const input = context.req.valid('json');
        return success(context, await authService.resetPassword(input));
      },
    )
    .post('/get-me', requireAuth, async (context) =>
      success(context, await authService.getMe({ userId: currentUserId() })),
    )
    .post('/update-info', requireAuth, jsonBody(UpdateInfoSchema), async (context) => {
      const input = context.req.valid('json');
      return success(
        context,
        await authService.updateInfo({ userId: currentUserId(), ...input }),
      );
    })
    .post(
      '/change-password',
      requireAuth,
      jsonBody(ChangePasswordSchema),
      async (context) => {
        const input = context.req.valid('json');
        return success(
          context,
          await authService.changePassword({
            userId: currentUserId(),
            ...input,
          }),
        );
      },
    );

  return routes;
};
