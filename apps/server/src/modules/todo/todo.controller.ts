import { Controller, Post, Body, UseGuards, Inject } from '@nestjs/common';
import { TodoService } from './todo.service.js';
import {
  CreateTodoDto,
  CursorQueryTodoDto,
  PageQueryTodoDto,
  TodoIdInputDto,
  UpdateTodoDto,
} from '@repo/shared';
import { z } from 'zod';
import { AuthGuard } from '../../guards/auth.guard.js';

@Controller('api/todo')
@UseGuards(AuthGuard)
export class TodoController {
  constructor(
    @Inject(TodoService) private readonly todoService: TodoService,
  ) {}

  @Post('create')
  create(@Body() input: z.infer<typeof CreateTodoDto>) {
    return this.todoService.create(input);
  }

  @Post('find-many')
  findMany(@Body() input: z.infer<typeof PageQueryTodoDto>) {
    return this.todoService.findMany(input);
  }

  @Post('find-many-cursor')
  findManyCursor(@Body() input: z.infer<typeof CursorQueryTodoDto>) {
    return this.todoService.findManyCursor(input);
  }

  @Post('find-by-id')
  findById(@Body() input: z.infer<typeof TodoIdInputDto>) {
    return this.todoService.findById(input.todoId);
  }

  @Post('update')
  update(@Body() input: z.infer<typeof UpdateTodoDto>) {
    return this.todoService.update(input);
  }

  @Post('remove')
  remove(@Body() input: z.infer<typeof TodoIdInputDto>) {
    return this.todoService.remove(input.todoId);
  }
}
