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
import { DbService } from '../../infra/db.service.js';
import { AppLoggerService } from '../../infra/logger.service.js';
import { AppError } from '../../errors.js';

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
        ? [new Date(cursor.updatedAt), cursor.id]
        : undefined,
      getCursor: (item) => ({
        updatedAt: item.updatedAt.toISOString(),
        id: item.id,
      }),
      where: keyword ? ilike(todos.title, `%${keyword}%`) : undefined,
      size,
    });
  }

  async findById(id: string) {
    this.logger.log('findById', { id });
    const [todo] = await this.db.select().from(todos).where(eq(todos.id, id));
    if (!todo) {
      this.logger.warn('findById not found', { id });
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

  async remove(id: string) {
    this.logger.log('remove', { id });
    const [todo] = await this.db
      .delete(todos)
      .where(eq(todos.id, id))
      .returning();
    if (!todo) {
      this.logger.warn('remove not found', { id });
      throw new AppError(AppErrorCodes.TodoNotFound);
    }
    this.logger.log('removed', { id: todo.id });
    return todo;
  }
}
