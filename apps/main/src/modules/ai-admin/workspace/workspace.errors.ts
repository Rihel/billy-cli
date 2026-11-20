import { AppErrorCodes } from '@repo/shared'
import { AppError } from '@repo/kits'

/**
 * 工作区的业务错误。
 *
 * 为什么不用 `NotFoundException` / `BadRequestException`：边界过滤器对框架 `HttpException`
 * 会丢弃自定义 message，只回字典里的通用文案（"请求体格式不正确"），排查时会被误导。
 * 业务错误一律走 `AppError` + 错误码（与其它模块同口径）。
 */
export class DefaultWorkspaceUndeletableError extends AppError {
  readonly code = AppErrorCodes.WorkspaceDefaultUndeletable
  constructor() {
    super('Default workspace cannot be removed')
  }
}

export class WorkspaceNotFoundError extends AppError {
  readonly code = AppErrorCodes.WorkspaceNotFound
  constructor(readonly workspaceId?: string) {
    super(`Workspace not found${workspaceId ? `: ${workspaceId}` : ''}`)
  }
}
