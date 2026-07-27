import { Controller, Post, UseGuards, Inject } from '@nestjs/common';
import { TodoService } from './todo.service.js';
import {
  CreateTodoDto,
  CursorQueryTodoDto,
  PageQueryTodoDto,
  TodoIdInputDto,
  UpdateTodoDto,
  TodoModel,
} from '@repo/shared';
import type { z } from 'zod';
import { ZBody, ZSerialize } from 'nest-zod';
import { AuthGuard } from '../../guards/auth.guard.js';

@Controller('todo')
@UseGuards(AuthGuard)
export class TodoController {
  constructor(@Inject(TodoService) private readonly todoService: TodoService) {}

  @Post('create')
  @ZSerialize(TodoModel)
  create(@ZBody(CreateTodoDto) input: z.infer<typeof CreateTodoDto>) {
    return this.todoService.create(input);
  }

  @Post('find-many')
  findMany(@ZBody(PageQueryTodoDto) input: z.infer<typeof PageQueryTodoDto>) {
    return this.todoService.findMany(input);
  }

  @Post('find-many-cursor')
  findManyCursor(@ZBody(CursorQueryTodoDto) input: z.infer<typeof CursorQueryTodoDto>) {
    return this.todoService.findManyCursor(input);
  }

  @Post('find-by-id')
  findById(@ZBody(TodoIdInputDto) input: z.infer<typeof TodoIdInputDto>) {
    return this.todoService.findById(input.todoId);
  }

  @Post('update')
  update(@ZBody(UpdateTodoDto) input: z.infer<typeof UpdateTodoDto>) {
    return this.todoService.update(input);
  }

  @Post('remove')
  remove(@ZBody(TodoIdInputDto) input: z.infer<typeof TodoIdInputDto>) {
    return this.todoService.remove(input.todoId);
  }
}
