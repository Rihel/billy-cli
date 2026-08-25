import { AuthService, type AppContext } from '@repo/core';
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
  const routes = new Hono();

  routes
    .post('/register', jsonBody(RegisterSchema), async (context) => {
      const input = context.req.valid('json');
      return success(context, await authService.register(input));
    })
    .post('/login', jsonBody(LoginSchema), async (context) => {
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
    .post('/forgot-password', jsonBody(ForgotPasswordSchema), async (context) => {
      const input = context.req.valid('json');
      return success(context, await authService.forgotPassword(input));
    })
    .post('/reset-password', jsonBody(ResetPasswordSchema), async (context) => {
      const input = context.req.valid('json');
      return success(context, await authService.resetPassword(input));
    })
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
