import { TodoService, type AppContext } from '@repo/core';
import {
  CreateTodoSchema,
  CursorQueryTodoSchema,
  GetDetailTodoSchema,
  PageQueryTodoSchema,
  RemoveTodoSchema,
  UpdateTodoSchema,
} from '@repo/shared';
import { Hono } from 'hono';
import { makeRequireAuth } from '../lib/authentication.js';
import { jsonBody, success } from '../lib/http.js';

export const makeTodoRoutes = (runtime: AppContext) => {
  const todoService = runtime.get(TodoService);
  const requireAuth = makeRequireAuth(runtime);
  const routes = new Hono();

  routes.use('*', requireAuth);
  routes
    .post('/create', jsonBody(CreateTodoSchema), async (context) => {
      const input = context.req.valid('json');
      return success(context, await todoService.create(input));
    })
    .post('/page-query', jsonBody(PageQueryTodoSchema), async (context) => {
      const input = context.req.valid('json');
      return success(context, await todoService.page(input));
    })
    .post('/cursor-query', jsonBody(CursorQueryTodoSchema), async (context) => {
      const input = context.req.valid('json');
      return success(context, await todoService.cursor(input));
    })
    .post('/detail', jsonBody(GetDetailTodoSchema), async (context) => {
      const input = context.req.valid('json');
      return success(context, await todoService.get(input));
    })
    .post('/update', jsonBody(UpdateTodoSchema), async (context) => {
      const input = context.req.valid('json');
      return success(context, await todoService.update(input));
    })
    .post('/remove', jsonBody(RemoveTodoSchema), async (context) => {
      const input = context.req.valid('json');
      return success(context, await todoService.remove(input));
    });

  return routes;
};
