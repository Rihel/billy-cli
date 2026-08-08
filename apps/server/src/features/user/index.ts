import {
  CreateUser,
  RemoveUser,
  ResetUserPassword,
  UpdateUser,
  UserId,
  UserPageQuery,
  createUser,
  getUser,
  pageUsers,
  removeUser,
  resetUserPassword,
  updateUser,
} from '@repo/core';
import {
  CreateUserSchema,
  GetUserDetailSchema,
  PageQueryUserDto,
  RemoveUserSchema,
  ResetUserPasswordSchema,
  UpdateUserSchema,
} from '@repo/shared';
import { Effect } from 'effect';
import { Hono } from 'hono';
import { Authentication } from '../../capabilities/authentication.js';
import { EffectExecutor } from '../../capabilities/effect-executor.js';
import { Http, type AppEnv } from '../../capabilities/http.js';

export const makeUserRoutes = Effect.gen(function* () {
  const executor = yield* EffectExecutor;
  const { jsonBody, success } = yield* Http;
  const { requireAuth } = yield* Authentication;
  const routes = new Hono<AppEnv>();

  routes.use('*', requireAuth);
  routes
    .post('/create', jsonBody(CreateUserSchema), async (context) => {
      const input = context.req.valid('json');
      return success(
        context,
        await executor.run(createUser(new CreateUser(input))),
      );
    })
    .post('/page-query', jsonBody(PageQueryUserDto), async (context) => {
      const input = context.req.valid('json');
      return success(
        context,
        await executor.run(pageUsers(new UserPageQuery(input))),
      );
    })
    .post('/detail', jsonBody(GetUserDetailSchema), async (context) => {
      const input = context.req.valid('json');
      return success(context, await executor.run(getUser(new UserId(input))));
    })
    .post('/update', jsonBody(UpdateUserSchema), async (context) => {
      const input = context.req.valid('json');
      return success(
        context,
        await executor.run(updateUser(new UpdateUser(input))),
      );
    })
    .post('/remove', jsonBody(RemoveUserSchema), async (context) => {
      const input = context.req.valid('json');
      return success(
        context,
        await executor.run(removeUser(new RemoveUser(input))),
      );
    })
    .post(
      '/reset-password',
      jsonBody(ResetUserPasswordSchema),
      async (context) => {
        const input = context.req.valid('json');
        return success(
          context,
          await executor.run(resetUserPassword(new ResetUserPassword(input))),
        );
      },
    );

  return routes;
});
