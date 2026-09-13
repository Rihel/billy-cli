import { Body, Controller, HttpCode, Inject, Post, UseGuards } from '@nestjs/common'
import {
  CreateTodoSchema,
  CursorQueryTodoSchema,
  GetDetailTodoSchema,
  PageQueryTodoSchema,
  RemoveTodoSchema,
  UpdateTodoSchema,
} from '@repo/shared'
import type {
  CreateTodoDto,
  CursorQueryTodoDto,
  GetDetailTodoDto,
  PageQueryTodoDto,
  RemoveTodoDto,
  UpdateTodoDto,
} from '@repo/shared'
import { AdminAuthGuard } from '../admin/admin-auth.guard.js'
import { TodoService } from './todo.service.js'

/** 待办业务路由（/todo/*，全部后台管理员鉴权；分页 + 游标两种列表） */
@Controller('todo')
@UseGuards(AdminAuthGuard)
export class TodoController {
  constructor(@Inject(TodoService) private readonly todoService: TodoService) {}

  @Post('create')
  @HttpCode(200)
  create(@Body({ schema: CreateTodoSchema }) input: CreateTodoDto) {
    return this.todoService.create(input)
  }

  @Post('page-query')
  @HttpCode(200)
  pageQuery(@Body({ schema: PageQueryTodoSchema }) input: PageQueryTodoDto) {
    return this.todoService.page(input)
  }

  @Post('cursor-query')
  @HttpCode(200)
  cursorQuery(@Body({ schema: CursorQueryTodoSchema }) input: CursorQueryTodoDto) {
    return this.todoService.cursor(input)
  }

  @Post('detail')
  @HttpCode(200)
  detail(@Body({ schema: GetDetailTodoSchema }) input: GetDetailTodoDto) {
    return this.todoService.get(input)
  }

  @Post('update')
  @HttpCode(200)
  update(@Body({ schema: UpdateTodoSchema }) input: UpdateTodoDto) {
    return this.todoService.update(input)
  }

  @Post('remove')
  @HttpCode(200)
  remove(@Body({ schema: RemoveTodoSchema }) input: RemoveTodoDto) {
    return this.todoService.remove(input)
  }
}
