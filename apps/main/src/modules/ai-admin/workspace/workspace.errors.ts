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

/**
 * 文件夹配置不合法（**语法**层：完整路径、不是 `/`、不含 `..`、底层后端必须是 local）。
 *
 * 存在性、是否落在允许根之内、是否是目录由执行面校验 —— main 与 workspace-service 可能不在
 * 同一台机器 / 同一个容器里，main 看不到宿主文件系统。
 */
export class WorkspaceHostRootInvalidError extends AppError {
  readonly code = AppErrorCodes.WorkspaceHostRootInvalid
  constructor(readonly reason: string) {
    super(`Invalid workspace host root: ${reason}`)
  }
}
