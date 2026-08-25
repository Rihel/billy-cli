import { UserService, type AppContext } from '@repo/core';
import {
  CreateUserSchema,
  GetUserDetailSchema,
  PageQueryUserDto,
  RemoveUserSchema,
  ResetUserPasswordSchema,
  UpdateUserSchema,
} from '@repo/shared';
import { Hono } from 'hono';
import { makeRequireAdminAuth } from '../lib/authentication.js';
import { jsonBody, success } from '../lib/http.js';

export const makeUserRoutes = (runtime: AppContext) => {
  const userService = runtime.get(UserService);
  const requireAdminAuth = makeRequireAdminAuth(runtime);
  const routes = new Hono();

  routes.use('*', requireAdminAuth);
  routes
    .post('/create', jsonBody(CreateUserSchema), async (context) => {
      const input = context.req.valid('json');
      return success(context, await userService.create(input));
    })
    .post('/page-query', jsonBody(PageQueryUserDto), async (context) => {
      const input = context.req.valid('json');
      return success(
        context,
        await userService.page(input),
      );
    })
    .post('/detail', jsonBody(GetUserDetailSchema), async (context) => {
      const input = context.req.valid('json');
      return success(context, await userService.get(input));
    })
    .post('/update', jsonBody(UpdateUserSchema), async (context) => {
      const input = context.req.valid('json');
      return success(
        context,
        await userService.update(input),
      );
    })
    .post('/remove', jsonBody(RemoveUserSchema), async (context) => {
      const input = context.req.valid('json');
      return success(
        context,
        await userService.remove(input),
      );
    })
    .post(
      '/reset-password',
      jsonBody(ResetUserPasswordSchema),
      async (context) => {
        const input = context.req.valid('json');
        return success(
          context,
          await userService.resetPassword(input),
        );
      },
    );

  return routes;
};
