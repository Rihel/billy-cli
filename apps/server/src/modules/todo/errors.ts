import { AppErrorCodes } from '@repo/shared'
import { AppError } from '@repo/kits'

export class TodoNotFoundError extends AppError {
  readonly code = AppErrorCodes.TodoNotFound
  constructor(readonly todoId: string) {
    super(`Todo not found: ${todoId}`)
  }
}
