import { Inject } from '@nestjs/common';
import { Router, Query, Mutation, Input, UseMiddlewares } from 'nestjs-trpc';
import {
  CreateTodoDto,
  CursorQueryTodoDto,
  PageQueryTodoDto,
  TodoIdInputDto,
  UpdateTodoDto,
} from '@repo/shared';
import { z } from 'zod';
import { TodoService } from './todo.service.js';
import { AuthMiddleware } from '../../middlewares/auth.middleware.js';

@Router({ alias: 'todo' })
@UseMiddlewares(AuthMiddleware)
export class TodoRouter {
  constructor(@Inject(TodoService) private readonly todoService: TodoService) {}

  @Mutation({ input: CreateTodoDto })
  create(@Input() input: z.infer<typeof CreateTodoDto>) {
    return this.todoService.create(input);
  }

  @Query({ input: PageQueryTodoDto })
  findMany(@Input() input: z.infer<typeof PageQueryTodoDto>) {
    return this.todoService.findMany(input);
  }

  @Query({ input: CursorQueryTodoDto })
  findManyCursor(@Input() input: z.infer<typeof CursorQueryTodoDto>) {
    return this.todoService.findManyCursor(input);
  }

  @Query({ input: TodoIdInputDto })
  findById(@Input('todoId') todoId: string) {
    return this.todoService.findById(todoId);
  }

  @Mutation({ input: UpdateTodoDto })
  update(@Input() input: z.infer<typeof UpdateTodoDto>) {
    return this.todoService.update(input);
  }

  @Mutation({ input: TodoIdInputDto })
  remove(@Input('todoId') todoId: string) {
    return this.todoService.remove(todoId);
  }
}
