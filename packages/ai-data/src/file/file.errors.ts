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
