/**
 * 业务/基础设施错误基类。
 *
 * 所有错误类必须提供 `code`（AppErrorCodes 数字码），
 * 应用边界（apps/main）据此映射 HTTP 状态码与错误信息，
 * 无需维护字符串查表。
 */
export abstract class AppError extends Error {
  /** 业务错误码（见 @repo/shared AppErrorCodes）。 */
  abstract readonly code: number

  /**
   * 业务码字典 label 之外的具体原因（可选）。
   *
   * 边界会把 `label：detail` 合成响应 message：字典只回答「哪一类失败」，
   * 而模型 / 用户要能看见「这一次为什么失败」（GitHub 限额、路径不存在、工作区没起…）。
   * 不传则只输出字典 label，保持既有响应形状不变。
   */
  readonly detail?: string

  constructor(message?: string, detail?: string) {
    super(message)
    // 自动取子类名作为 Error.name，子类无需重复设置。
    this.name = new.target.name
    if (detail?.trim()) this.detail = detail.trim()
  }
}
