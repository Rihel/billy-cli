import {
  AuthUserId,
  ChangePasswordCommand,
  ForgotPasswordCommand,
  LoginCommand,
  RegisterCommand,
  ResetPasswordCommand,
  UpdateInfoCommand,
  changePassword,
  forgotPassword,
  getMe,
  login,
  register,
  resetPassword,
  updateInfo,
} from '@repo/core';
import {
  ChangePasswordSchema,
  ForgotPasswordSchema,
  LoginSchema,
  RegisterSchema,
  ResetPasswordSchema,
  UpdateInfoSchema,
} from '@repo/shared';
import { Effect } from 'effect';
import { Hono } from 'hono';
import { Authentication } from '../../capabilities/authentication.js';
import { EffectExecutor } from '../../capabilities/effect-executor.js';
import { Http, type AppEnv } from '../../capabilities/http.js';
import { RequestContext } from '../../capabilities/request-context.js';

const currentUserId = Effect.gen(function* () {
  const context = yield* RequestContext;
  if (!context.userId) {
    throw new Error('Authenticated request context is unavailable');
  }
  return context.userId;
});

export const makeAuthRoutes = Effect.gen(function* () {
  const executor = yield* EffectExecutor;
  const { jsonBody, success } = yield* Http;
  const { requireAuth } = yield* Authentication;

  return new Hono<AppEnv>()
    .post('/register', jsonBody(RegisterSchema), async (context) => {
      const input = context.req.valid('json');
      return success(
        context,
        await executor.run(register(new RegisterCommand(input))),
      );
    })
    .post('/login', jsonBody(LoginSchema), async (context) => {
      const input = context.req.valid('json');
      return success(
        context,
        await executor.run(login(new LoginCommand(input))),
      );
    })
    .post(
      '/forgot-password',
      jsonBody(ForgotPasswordSchema),
      async (context) => {
        const input = context.req.valid('json');
        return success(
          context,
          await executor.run(forgotPassword(new ForgotPasswordCommand(input))),
        );
      },
    )
    .post('/reset-password', jsonBody(ResetPasswordSchema), async (context) => {
      const input = context.req.valid('json');
      return success(
        context,
        await executor.run(resetPassword(new ResetPasswordCommand(input))),
      );
    })
    .use('/get-me', requireAuth)
    .post('/get-me', async (context) =>
      success(
        context,
        await executor.run(
          Effect.flatMap(currentUserId, (userId) =>
            getMe(new AuthUserId({ userId })),
          ),
        ),
      ),
    )
    .use('/update-info', requireAuth)
    .post('/update-info', jsonBody(UpdateInfoSchema), async (context) => {
      const input = context.req.valid('json');
      return success(
        context,
        await executor.run(
          Effect.flatMap(currentUserId, (userId) =>
            updateInfo(new UpdateInfoCommand({ userId, ...input })),
          ),
        ),
      );
    })
    .use('/change-password', requireAuth)
    .post(
      '/change-password',
      jsonBody(ChangePasswordSchema),
      async (context) => {
        const input = context.req.valid('json');
        return success(
          context,
          await executor.run(
            Effect.flatMap(currentUserId, (userId) =>
              changePassword(new ChangePasswordCommand({ userId, ...input })),
            ),
          ),
        );
      },
    );
});
