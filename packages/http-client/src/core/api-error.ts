/**
 * 统一 API 异常。
 *
 * 继承 Error，支持 JSON 序列化（JSON.stringify 可正确输出所有字段）。
 */
export class ApiError extends Error {
  /** 错误码 */
  readonly code: string
  /** HTTP 状态码（可选） */
  readonly status?: number
  /** 附加错误信息（可选） */
  readonly details?: any

  constructor(
    code: string,
    message: string,
    options?: { status?: number; details?: any },
  ) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.status = options?.status
    this.details = options?.details
  }

  toJSON(): Record<string, any> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      status: this.status,
      details: this.details,
    }
  }
}

/** 预定义的 SDK 错误码 */
export const ApiErrorCodes = {
  /** 凭证无效或未提供 */
  Unauthorized: 'UNAUTHORIZED',
  /** 权限不足 */
  Forbidden: 'FORBIDDEN',
  /** 资源不存在 */
  NotFound: 'NOT_FOUND',
  /** 资源冲突（如邮箱已被注册） */
  Conflict: 'CONFLICT',
  /** 请求参数校验失败 */
  ValidationError: 'VALIDATION_ERROR',
  /** 服务器内部错误 */
  InternalError: 'INTERNAL_ERROR',
  /** 网络异常（无法连接、超时、DNS 解析失败等） */
  NetworkError: 'NETWORK_ERROR',
  /** 未配置 refresh，无法刷新 */
  NoRefreshAvailable: 'NO_REFRESH_AVAILABLE',
} as const

/** 后端 AppError value 映射为 SDK ApiErrorCode */
export function mapAppErrorValue(value: number): string {
  if (value === 1002 || value === 1005 || value === 1006) return ApiErrorCodes.Unauthorized
  if (value === 1007) return ApiErrorCodes.Forbidden
  if (value === 1000 || value === 2001 || value === 3001) return ApiErrorCodes.NotFound
  if (value === 1001) return ApiErrorCodes.Conflict
  if (value === 1003 || value === 1004 || value === 1008 || value === 1009) return ApiErrorCodes.ValidationError
  if (value === 5001) return ApiErrorCodes.InternalError
  return ApiErrorCodes.InternalError
}

/** HTTP 状态码映射为 SDK ApiErrorCode */
export function mapHttpStatus(status: number): string {
  if (status === 401) return ApiErrorCodes.Unauthorized
  if (status === 403) return ApiErrorCodes.Forbidden
  if (status === 404) return ApiErrorCodes.NotFound
  if (status === 409) return ApiErrorCodes.Conflict
  if (status === 400) return ApiErrorCodes.ValidationError
  if (status >= 500) return ApiErrorCodes.InternalError
  return ApiErrorCodes.InternalError
}
