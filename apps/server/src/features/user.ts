import { UserService, appCore } from '@repo/core';
import {
  CreateUserSchema,
  GetUserDetailSchema,
  PageQueryUserDto,
  RemoveUserSchema,
  ResetUserPasswordSchema,
  UpdateUserSchema,
} from '@repo/shared';
import { Hono } from 'hono';
import { requireAuth } from '../lib/authentication.js';
import { jsonBody, success } from '../lib/http.js';

export const makeUserRoutes = () => {
  const userService = appCore.get(UserService);
  const routes = new Hono();

  routes.use('*', requireAuth);
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
