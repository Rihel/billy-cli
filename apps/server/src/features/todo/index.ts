import {
  CreateTodo,
  TodoCursor,
  TodoCursorQuery,
  TodoId,
  TodoPageQuery,
  UpdateTodo,
  createTodo,
  cursorTodos,
  getTodo,
  pageTodos,
  removeTodo,
  updateTodo,
} from '@repo/core';
import {
  CreateTodoSchema,
  CursorQueryTodoSchema,
  GetDetailTodoSchema,
  PageQueryTodoSchema,
  RemoveTodoSchema,
  UpdateTodoSchema,
} from '@repo/shared';
import { Effect } from 'effect';
import { Hono } from 'hono';
import { Authentication } from '../../capabilities/authentication.js';
import { EffectExecutor } from '../../capabilities/effect-executor.js';
import { Http, type AppEnv } from '../../capabilities/http.js';

export const makeTodoRoutes = Effect.gen(function* () {
  const executor = yield* EffectExecutor;
  const { jsonBody, success } = yield* Http;
  const { requireAuth } = yield* Authentication;
  const routes = new Hono<AppEnv>();

  routes.use('*', requireAuth);
  routes
    .post('/create', jsonBody(CreateTodoSchema), async (context) => {
      const input = context.req.valid('json');
      return success(
        context,
        await executor.run(createTodo(new CreateTodo(input))),
      );
    })
    .post('/page-query', jsonBody(PageQueryTodoSchema), async (context) => {
      const input = context.req.valid('json');
      return success(
        context,
        await executor.run(pageTodos(new TodoPageQuery(input))),
      );
    })
    .post('/cursor-query', jsonBody(CursorQueryTodoSchema), async (context) => {
      const input = context.req.valid('json');
      return success(
        context,
        await executor.run(
          cursorTodos(
            new TodoCursorQuery({
              ...input,
              cursor: input.cursor ? new TodoCursor(input.cursor) : undefined,
            }),
          ),
        ),
      );
    })
    .post('/detail', jsonBody(GetDetailTodoSchema), async (context) => {
      const input = context.req.valid('json');
      return success(context, await executor.run(getTodo(new TodoId(input))));
    })
    .post('/update', jsonBody(UpdateTodoSchema), async (context) => {
      const input = context.req.valid('json');
      return success(
        context,
        await executor.run(updateTodo(new UpdateTodo(input))),
      );
    })
    .post('/remove', jsonBody(RemoveTodoSchema), async (context) => {
      const input = context.req.valid('json');
      return success(
        context,
        await executor.run(removeTodo(new TodoId(input))),
      );
    });

  return routes;
});
