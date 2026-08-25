/**
 * 业务/基础设施错误基类。
 *
 * 所有错误类必须提供 `code`（AppErrorCodes 数字码），
 * 应用边界（apps/server）据此映射 HTTP 状态码与错误信息，
 * 无需维护字符串查表。
 */
export abstract class AppError extends Error {
  /** 业务错误码（见 @repo/shared AppErrorCodes）。 */
  abstract readonly code: number

  constructor(message?: string) {
    super(message)
    // 自动取子类名作为 Error.name，子类无需重复设置。
    this.name = new.target.name
  }
}
