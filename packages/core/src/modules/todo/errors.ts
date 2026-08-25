import { AppErrorCodes } from '@repo/shared'
import { AppError } from '../../foundation/errors/app-error.js'

export class TodoNotFoundError extends AppError {
  readonly code = AppErrorCodes.TodoNotFound
  constructor(readonly todoId: string) {
    super(`Todo not found: ${todoId}`)
  }
}
