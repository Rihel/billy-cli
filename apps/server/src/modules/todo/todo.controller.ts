import { Controller, Post, UseGuards, Inject } from '@nestjs/common';
import { TodoService } from './todo.service.js';
import {
  CreateTodoDto,
  CursorQueryTodoDto,
  PageQueryTodoDto,
  UpdateTodoDto,
  TodoModel,
  GetDetailTodoDto,
  RemoveTodoDto,
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

  @Post('page-query')
  pageQuery(@ZBody(PageQueryTodoDto) input: z.infer<typeof PageQueryTodoDto>) {
    return this.todoService.pageQuery(input);
  }

  @Post('cursor-query')
  cursorQuery(
    @ZBody(CursorQueryTodoDto) input: z.infer<typeof CursorQueryTodoDto>,
  ) {
    return this.todoService.cursorQuery(input);
  }

  @Post('detail')
  detail(@ZBody(GetDetailTodoDto) input: z.infer<typeof GetDetailTodoDto>) {
    return this.todoService.detail(input);
  }

  @Post('update')
  update(@ZBody(UpdateTodoDto) input: z.infer<typeof UpdateTodoDto>) {
    return this.todoService.update(input);
  }

  @Post('remove')
  remove(@ZBody(RemoveTodoDto) input: z.infer<typeof RemoveTodoDto>) {
    return this.todoService.remove(input);
  }
}
