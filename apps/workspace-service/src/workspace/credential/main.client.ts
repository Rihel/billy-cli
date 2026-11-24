import {
  InternalApiError,
  InternalProtocolError,
  InternalTimeoutError,
  InternalTransportError,
  MainInternalClient,
} from '@repo/internal-sdk'
import type { CredentialImportResponse } from '@repo/contracts'

/** 调 main 内部凭据接口要的东西（地址 + 内部令牌） */
export interface CredentialMainTarget {
  mainUrl: string
  /** main 的 `/internal/*` 认 `TOOL_INTERNAL_TOKEN`，不是 WORKSPACE_INTERNAL_TOKEN */
  token: string
}

/** 交给 main 加密入库的请求体（与 `CredentialImportRequestSchema` 同形） */
export interface CredentialImportBody {
  ownerType: 'user' | 'admin'
  ownerId: string
  provider: string
  template?: string
  name?: string
  values: Record<string, unknown>
}

/** main 的错误信封里带中文原因（`{ code, message }`）；网关错误页可能不是 JSON */
const reasonOf = (detail: string): string => {
  try {
    const parsed = JSON.parse(detail) as { message?: unknown }
    if (typeof parsed.message === 'string' && parsed.message.trim()) return parsed.message.trim()
  } catch {
    // 忽略：按原文截断即可
  }
  return detail.trim().slice(0, 300)
}

/** 内部调用失败的中文描述（错误码 / 原因都不含凭据值） */
export const describeInternalFailure = (error: unknown): string => {
  if (error instanceof InternalApiError) {
    const reason = reasonOf(error.detail)
    return `HTTP ${error.status}${reason ? `（${reason}）` : ''}`
  }
  if (error instanceof InternalProtocolError) return '响应不符合契约'
  if (error instanceof InternalTimeoutError) return '控制面调用超时'
  if (error instanceof InternalTransportError) return '控制面不可用'
  return error instanceof Error ? error.message : String(error)
}

/**
 * 凭据入库：把值交给 main 加密写库（值只走内部通道，不回显、不落日志）。
 *
 * **失败必须透传控制面的原因**：执行面的模型只能靠错误文案自纠；
 * 只报 `HTTP 400` 等于让它猜 —— 键名写成 `snake_case` 时它永远改不对。
 */
export const importCredentialToMain = async (
  target: CredentialMainTarget,
  body: CredentialImportBody,
): Promise<CredentialImportResponse['credential']> => {
  const client = new MainInternalClient({
    baseUrl: target.mainUrl,
    token: target.token,
    timeoutMs: 20_000,
  })
  try {
    const result = await client.importCredential(body)
    return result.credential
  } catch (error) {
    throw new Error(`凭据入库失败：${describeInternalFailure(error)}`)
  }
}
