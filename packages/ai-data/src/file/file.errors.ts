import { AppErrorCodes } from '@repo/shared'
import { AppError } from '@repo/kits'

/** 文件数据层的业务拒绝：字段与 server 的 ToolDeniedError 同形，调用方按 reason/retryable 翻结论 */
export class FileDeniedError extends Error {
  readonly reason: string
  readonly retryable: boolean
  readonly hint?: string

  constructor(reason: string, message: string, hint?: string, retryable = false) {
    super(message)
    this.name = 'FileDeniedError'
    this.reason = reason
    this.hint = hint
    this.retryable = retryable
  }
}

/**
 * 文件边界的业务错误（issue A）：必须带业务码交给全局过滤器，
 * 否则控制器 rethrow 成 `BadRequestException` 后会被统一成「请求体格式不正确」，
 * 真实原因（不存在 / 目录 / 不是文本 / 工作区没起）全部丢失。
 *
 * `detail` 交给基类拼进响应 message（`文件参数不合法：…`），
 * `label` 保持字典里的稳定语义（前端 / SDK 可按 code 分支）。
 */
abstract class FileAppError extends AppError {
  constructor(message: string, detail?: string) {
    super(message, detail)
  }
}

/** 文件在工作区里确实不存在（区别于「不是普通文件」与「执行面不可达」） */
export class FileNotFoundError extends FileAppError {
  readonly code = AppErrorCodes.FileNotFound
  constructor(detail?: string) {
    super('文件不存在或已删除', detail)
  }
}

/** 存在但不可预览：目录 / 非文本 / 二进制 */
export class FileNotPreviewableError extends FileAppError {
  readonly code = AppErrorCodes.FileNotPreviewable
  constructor(detail: string) {
    super('该文件不支持预览', detail)
  }
}

/** 入参不合法：路径越界、空路径、软链逃逸等 */
export class FileInvalidInputError extends FileAppError {
  readonly code = AppErrorCodes.FileInvalidInput
  constructor(detail: string) {
    super('文件参数不合法', detail)
  }
}

/** 执行面不可用：工作区没起 / 远程调用失败（可重试，不是文件本身的问题） */
export class FileWorkspaceUnavailableError extends FileAppError {
  readonly code = AppErrorCodes.FileWorkspaceUnavailable
  constructor(detail: string) {
    super('工作区暂不可用', detail)
  }
}

/** 越权访问（不属于当前会话 / 当前用户） */
export class FileForbiddenError extends FileAppError {
  readonly code = AppErrorCodes.FileForbidden
  constructor(detail: string) {
    super('无权访问该文件', detail)
  }
}
