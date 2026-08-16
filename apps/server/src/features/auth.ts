import { AuthService, appCore } from '@repo/core';
import {
  ChangePasswordSchema,
  ForgotPasswordSchema,
  LoginSchema,
  RegisterSchema,
  ResetPasswordSchema,
  UpdateInfoSchema,
} from '@repo/shared';
import { Hono } from 'hono';
import { requireAuth } from '../lib/authentication.js';
import { jsonBody, success } from '../lib/http.js';
import { requestContext } from '../lib/request-context.js';

const currentUserId = (): string => {
  const userId = requestContext.get('userId');
  if (!userId) {
    throw new Error('Authenticated request context is unavailable');
  }
  return userId;
};

export const makeAuthRoutes = () => {
  const authService = appCore.get(AuthService);
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
