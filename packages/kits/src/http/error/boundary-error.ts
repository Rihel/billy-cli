import { AppErrorCodes } from '@repo/shared'
import { describeErrorCode, type ErrorHttpStatus } from './error-descriptor.js'

/**
 * 边界错误：由 HTTP 边界层（守卫 / 拦截器）抛出，携带 AppResponse 业务码 + 中文文案 +
 * HTTP 状态 + 可选响应头，由 AppExceptionFilter 统一渲染为 AppResponse 信封。
 *
 * 业务 / 基础设施错误仍走 `AppError`（code 查字典）；本类只用于「字典表达不了的边界语义」
 * （如需要附加 `Retry-After` 响应头的限流拒绝）。
 */
export class BoundaryError extends Error {
  constructor(
    readonly value: number,
    readonly label: string,
    readonly http: ErrorHttpStatus,
    readonly headers: Record<string, string> = {},
  ) {
    super(label)
    this.name = new.target.name
  }
}

/** 便捷工厂：按 AppErrorCodes 字典构造边界错误 */
export const boundaryErrorOf = (code: number): BoundaryError => {
  const descriptor = describeErrorCode(code)
  return new BoundaryError(descriptor.value, descriptor.label, descriptor.http)
}

/** 未认证（缺 token）：401 */
export const unauthorizedError = (): BoundaryError => boundaryErrorOf(AppErrorCodes.Unauthorized)

/** token 无效 / 过期：401 */
export const tokenInvalidError = (): BoundaryError => boundaryErrorOf(AppErrorCodes.TokenInvalid)
