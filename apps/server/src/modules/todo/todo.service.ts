import { Injectable } from '@nestjs/common';
import { todos } from '@repo/db';
import {
  AppErrorCodes,
  CreateTodoDto,
  CursorQueryTodoDto,
  PageQueryTodoDto,
  UpdateTodoDto,
} from '@repo/shared';
import { eq, ilike } from 'drizzle-orm';
import { PgColumn } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import { AppError, AppLoggerService, DbService } from '@repo/kits';

@Injectable()
export class TodoService {
  constructor(
    private db: DbService,
    private logger: AppLoggerService,
  ) {}

  async create(input: z.infer<typeof CreateTodoDto>) {
    this.logger.log('create', input);
    const [todo] = await this.db.insert(todos).values(input).returning();
    this.logger.log('created', { id: todo.id });
    return todo;
  }

  async findMany(input: z.infer<typeof PageQueryTodoDto>) {
    this.logger.log('findMany', input);
    const { page, size, keyword, orderBy, order } = input;
    const where = keyword ? ilike(todos.title, `%${keyword}%`) : undefined;
    const result = await this.db.paginate({
      table: todos,
      where,
      orderCol: todos[orderBy as keyof typeof todos] as PgColumn,
      order,
      page,
      size,
    });
    this.logger.log('findMany result', { total: result.total, page, size });
    return result;
  }

  async findManyCursor(input: z.infer<typeof CursorQueryTodoDto>) {
    const { cursor, keyword, size } = input;
    return this.db.paginateCursor({
      table: todos,
      cursorColumns: [todos.updatedAt, todos.id],
      cursorValues: cursor
        ? [new Date(cursor.updatedAt), cursor.todoId]
        : undefined,
      getCursor: (item) => ({
        updatedAt: item.updatedAt.toISOString(),
        todoId: item.id,
      }),
      where: keyword ? ilike(todos.title, `%${keyword}%`) : undefined,
      size,
    });
  }

  async findById(todoId: string) {
    this.logger.log('findById', { todoId });
    const [todo] = await this.db
      .select()
      .from(todos)
      .where(eq(todos.id, todoId));
    if (!todo) {
      this.logger.warn('findById not found', { todoId });
      throw new AppError(AppErrorCodes.TodoNotFound);
    }
    return todo;
  }

  async update(input: z.infer<typeof UpdateTodoDto>) {
    this.logger.log('update', input);
    const { todoId, ...fields } = input;
    const [todo] = await this.db
      .update(todos)
      .set(fields)
      .where(eq(todos.id, todoId))
      .returning();
    if (!todo) {
      this.logger.warn('update not found', { todoId });
      throw new AppError(AppErrorCodes.TodoNotFound);
    }
    this.logger.log('updated', { id: todo.id });
    return todo;
  }

  async remove(todoId: string) {
    this.logger.log('remove', { todoId });
    const [todo] = await this.db
      .delete(todos)
      .where(eq(todos.id, todoId))
      .returning();
    if (!todo) {
      this.logger.warn('remove not found', { todoId });
      throw new AppError(AppErrorCodes.TodoNotFound);
    }
    this.logger.log('removed', { id: todo.id });
    return todo;
  }
}
