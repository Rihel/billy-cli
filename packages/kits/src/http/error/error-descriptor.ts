import { HttpException } from '@nestjs/common'
import { AppErrorCodes } from '@repo/shared'

/**
 * 业务错误码字典映射出的 HTTP 状态（收敛到合法集合）。
 *
 * 含 `503`：就绪探针（readiness）要在依赖不可用时**主动摘流** —— 返回 500 会被
 * 误读成「系统错误」，而 503 的语义正是「本实例暂时不接流量」（k8s 只把 2xx/3xx 当成就绪）。
 */
export type ErrorHttpStatus = 400 | 401 | 403 | 404 | 409 | 429 | 500 | 503

export interface ErrorDescriptor {
  /** AppResponse.code（业务错误码） */
  value: number
  /** 实际 HTTP 状态码 */
  http: ErrorHttpStatus
  /** 中文文案 */
  label: string
  /** 具体原因（有则边界拼成 `label：detail`，见 `messageOfDescriptor`） */
  detail?: string
}

const toErrorHttpStatus = (status: unknown): ErrorHttpStatus => {
  switch (status) {
    case 400:
    case 401:
    case 403:
    case 404:
    case 409:
    case 429:
    case 500:
    case 503:
      return status
    default:
      return 500
  }
}

export const describeErrorCode = (code: number): ErrorDescriptor => {
  const descriptor = AppErrorCodes.getOption(code)
  return descriptor
    ? {
        value: Number(descriptor.value),
        http: toErrorHttpStatus(descriptor.http),
        label: String(descriptor.label),
      }
    : { value: AppErrorCodes.Internal, http: 500, label: '系统错误' }
}

/**
 * 响应 message：有 detail 时拼成 `label：detail`。
 *
 * 为什么是「拼接」而不是二选一：label 让用户 / 模型知道失败类别（可据它决定下一步），
 * detail 才是这一次的具体原因（限额、超时、路径不存在）。只给 label 会让执行面模型
 * 无从自纠，只给 detail 又会丢掉稳定的错误语义。
 */
export const messageOfDescriptor = (descriptor: ErrorDescriptor): string =>
  descriptor.detail ? `${descriptor.label}：${descriptor.detail}` : descriptor.label

/** AppError 及自定义错误统一以数字 `code` 标识业务错误码 */
const hasAppErrorCode = (error: unknown): error is { code: number } =>
  !!error &&
  typeof error === 'object' &&
  'code' in error &&
  typeof (error as { code?: unknown }).code === 'number'

/** Express 生态错误（如 body-parser）以 `status` / `statusCode` 标识 HTTP 状态 */
const expressStatusOf = (error: unknown): number | undefined => {
  if (!error || typeof error !== 'object') return undefined
  const candidate =
    (error as { status?: unknown }).status ?? (error as { statusCode?: unknown }).statusCode
  return typeof candidate === 'number' && candidate >= 400 && candidate < 600
    ? candidate
    : undefined
}

/**
 * 将边界抛出的错误映射为 AppResponse 响应描述：
 * 1. 业务 / 基础设施错误类自带数字 `code`（AppErrorCodes）→ 查字典得 HTTP + 中文；
 * 2. Nest 路由未命中（NotFoundException）→ 404 `接口不存在`；
 * 3. 其它 HttpException / Express 错误（如请求体 JSON 解析失败）→ 按状态码兜底；
 * 4. 未知错误 → 系统错误 5001 / HTTP 500。
 */
export const mapError = (error: unknown): ErrorDescriptor => {
  if (hasAppErrorCode(error)) {
    const descriptor = describeErrorCode(error.code)
    // 字典 label 只回答「哪一类失败」；带 detail 的错误把「这一次为什么失败」一并交出去
    const detail =
      'detail' in error && typeof (error as { detail?: unknown }).detail === 'string'
        ? (error as { detail?: string }).detail?.trim()
        : undefined
    return detail ? { ...descriptor, detail } : descriptor
  }
  if (error instanceof HttpException) {
    const status = error.getStatus()
    if (status === 404) {
      return { value: 404, http: 404, label: '接口不存在' }
    }
    return {
      value: status,
      http: toErrorHttpStatus(status),
      // 无业务码的 HttpException 只可能来自框架层（如 body-parser 解析失败）
      label: status === 400 ? '请求体格式不正确' : '请求失败',
    }
  }
  const status = expressStatusOf(error)
  if (status !== undefined) {
    return {
      value: status,
      http: toErrorHttpStatus(status),
      label: status === 400 ? '请求体格式不正确' : '请求失败',
    }
  }
  return describeErrorCode(AppErrorCodes.Internal)
}
