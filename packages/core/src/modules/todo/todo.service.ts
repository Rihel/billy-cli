import {
  Transactional,
  type CursorQueryResult,
  type PageQueryResult,
} from '@repo/db'
import type {
  CreateTodoDto,
  CursorQueryTodoDto,
  GetDetailTodoDto,
  PageQueryTodoDto,
  RemoveTodoDto,
  TodoCursorModel,
  TodoModel,
  UpdateTodoDto,
} from '@repo/shared'
import { inject, injectable } from 'inversify'
import type { AppLogger } from '@repo/shared/logger'
import { Logger } from '../../shared/logger.decorator.js'
import { TodoRepository } from './todo.repository.js'
import { TodoNotFoundError } from './errors.js'

@injectable()
export class TodoService {
  @Logger()
  private readonly logger!: AppLogger

  constructor(
    @inject(TodoRepository) private readonly todoRepository: TodoRepository,
  ) {}

  @Transactional()
  async create(input: CreateTodoDto): Promise<TodoModel> {
    const todo = await this.todoRepository.create(input)
    this.logger.log('todo.created', { id: todo.id })
    return todo
  }

  async get(input: GetDetailTodoDto): Promise<TodoModel> {
    const todo = await this.todoRepository.findById(input.todoId)
    if (!todo) throw new TodoNotFoundError(input.todoId)
    return todo
  }

  async page(query: PageQueryTodoDto): Promise<PageQueryResult<TodoModel>> {
    return this.todoRepository.page(query)
  }

  async cursor(
    query: CursorQueryTodoDto,
  ): Promise<CursorQueryResult<TodoModel, TodoCursorModel>> {
    return this.todoRepository.cursor(query)
  }

  @Transactional()
  async update(input: UpdateTodoDto): Promise<TodoModel> {
    const { todoId, ...changes } = input
    const todo = await this.todoRepository.update(todoId, changes)
    if (!todo) throw new TodoNotFoundError(todoId)
    this.logger.log('todo.updated', { id: todoId })
    return todo
  }

  @Transactional()
  async remove(input: RemoveTodoDto): Promise<TodoModel> {
    const todo = await this.todoRepository.remove(input.todoId)
    if (!todo) throw new TodoNotFoundError(input.todoId)
    this.logger.log('todo.removed', { id: input.todoId })
    return todo
  }
}
