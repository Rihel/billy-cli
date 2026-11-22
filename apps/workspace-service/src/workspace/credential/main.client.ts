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

/** main 的响应信封（成功 `{ code: 0, data }`，失败 `{ code, message }`） */
interface Envelope {
  code?: number
  data?: CredentialImportResponse
  message?: string
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
  const response = await fetch(new URL('/internal/credentials/import', target.mainUrl), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-internal-token': target.token,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  })
  // 先读文本：非 2xx 时响应体里的中文原因也要拿到（网关错误页可能不是 JSON）
  const text = await response.text()
  let envelope: Envelope = {}
  try {
    envelope = text ? (JSON.parse(text) as Envelope) : {}
  } catch {
    envelope = {}
  }
  if (!response.ok) {
    const detail = envelope.message?.trim() || text.trim().slice(0, 300)
    throw new Error(`凭据入库失败：HTTP ${response.status}${detail ? `（${detail}）` : ''}`)
  }
  if (!envelope.data) throw new Error(envelope.message?.trim() || '凭据入库失败：响应缺少 data')
  return envelope.data.credential
}
