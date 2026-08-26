import {
  cursorPageWith,
  pageWith,
  TodoEntity,
  type CursorQueryResult,
  type PageQueryResult,
} from '@repo/db'
import type {
  CursorQueryTodoDto,
  PageQueryTodoDto,
  TodoCursorModel,
  TodoModel,
} from '@repo/shared'
import { type DeepPartial } from 'typeorm'
import { Inject, Injectable } from '@repo/di'
import { Db } from '../../infrastructure/database.js'

const toTodo = (record: TodoEntity): TodoModel => {
  const { deletedAt: _deletedAt, ...todo } = record
  return todo
}


@Injectable()
export class TodoRepository {
  constructor(@Inject(Db) private readonly db: Db) {}

  private async repo() {
    return this.db.getRepository(TodoEntity)
  }

  async create(data: DeepPartial<TodoEntity>): Promise<TodoModel> {
    const repo = await this.repo()
    return toTodo(await repo.save(repo.create(data)))
  }

  async findById(id: string): Promise<TodoModel | null> {
    const repo = await this.repo()
    const todo = await repo.findOneBy({ id })
    return todo ? toTodo(todo) : null
  }

  async update(
    id: string,
    data: DeepPartial<TodoEntity>,
  ): Promise<TodoModel | null> {
    const repo = await this.repo()
    const existing = await repo.findOneBy({ id })
    if (!existing) return null
    Object.assign(existing, data)
    return toTodo(await repo.save(existing))
  }

  async remove(id: string): Promise<TodoModel | null> {
    const repo = await this.repo()
    const existing = await repo.findOneBy({ id })
    if (!existing) return null
    await repo.remove(existing)
    return toTodo(existing)
  }

  async page(
    query: PageQueryTodoDto,
  ): Promise<PageQueryResult<TodoModel>> {
    const { page, size, keyword, orderBy = 'updatedAt', order = 'desc' } = query
    const repo = await this.repo()
    const builder = repo.createQueryBuilder('t')
    if (keyword) {
      builder.andWhere('t.title ILIKE :keyword', { keyword: `%${keyword}%` })
    }
    builder.orderBy(`t.${orderBy}`, order === 'asc' ? 'ASC' : 'DESC')
    const { data, total } = await pageWith(builder, page, size)
    return { items: data.map(toTodo), total, page, size }
  }

  async cursor(
    query: CursorQueryTodoDto,
  ): Promise<CursorQueryResult<TodoModel, TodoCursorModel>> {
    const { cursor, keyword, size } = query
    const repo = await this.repo()
    const builder = repo.createQueryBuilder('t')
    if (keyword) {
      builder.andWhere('t.title ILIKE :keyword', { keyword: `%${keyword}%` })
    }
    builder.orderBy('t.updatedAt', 'DESC').addOrderBy('t.id', 'DESC')
    const result = await cursorPageWith<TodoEntity>(builder, {
      cursorColumns: ['updatedAt', 'id'],
      cursorValues: cursor ? [new Date(cursor.updatedAt), cursor.todoId] : undefined,
      getCursor: (row) =>
        ({
          updatedAt: row.updatedAt.toISOString(),
          todoId: row.id,
        }) satisfies TodoCursorModel,
      order: 'desc',
      size,
    })
    return {
      items: result.data.map(toTodo),
      nextCursor: result.nextCursor as TodoCursorModel | null,
    }
  }
}
