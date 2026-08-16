import type { CursorQueryResult, PageQueryResult } from '@repo/db'
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
import { Logger } from '../../shared/logger.js'
import { TodoRepository } from './todo.repository.js'
import { TodoNotFoundError } from './errors.js'

@injectable()
export class TodoService {
  constructor(
    @inject(TodoRepository) private readonly todoRepository: TodoRepository,
    @inject(Logger) private readonly logger: Logger,
  ) {}

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

  async update(input: UpdateTodoDto): Promise<TodoModel> {
    const { todoId, ...changes } = input
    const todo = await this.todoRepository.update(todoId, changes)
    if (!todo) throw new TodoNotFoundError(todoId)
    this.logger.log('todo.updated', { id: todoId })
    return todo
  }

  async remove(input: RemoveTodoDto): Promise<TodoModel> {
    const todo = await this.todoRepository.remove(input.todoId)
    if (!todo) throw new TodoNotFoundError(input.todoId)
    this.logger.log('todo.removed', { id: input.todoId })
    return todo
  }
}
