import { Inject, Injectable } from '@nestjs/common'
import type { CredentialResolvedItem } from '@repo/contracts'
import {
  WorkspaceServiceConfig,
  type WorkspaceServiceConfigValue,
} from '../../config/app-config.js'

/** 解析请求（与 main 的 `/internal/credentials/resolve` 契约一致） */
export interface ResolveCredentialInput {
  ownerType: 'user' | 'admin'
  ownerId: string
  names: string[]
}

/**
 * 执行面 → main 的凭据解析客户端。
 *
 * 为什么走 HTTP 而不是直连库解密：解密密钥只在 main（控制面）持有，
 * 执行面对 `personal_credentials` 只读且拿不到明文。这也是 §6.4.6 的分工：
 * 刷新与解密都在 main，执行面只负责"把拿到的值落地"。
 */
@Injectable()
export class WorkspaceCredentialClient {
  constructor(
    @Inject(WorkspaceServiceConfig) private readonly config: WorkspaceServiceConfigValue,
  ) {}

  async resolve(input: ResolveCredentialInput): Promise<CredentialResolvedItem[]> {
    if (input.names.length === 0) return []
    const response = await fetch(new URL('/internal/credentials/resolve', this.config.mainUrl), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // main 的 `/internal/*` 认 `TOOL_INTERNAL_TOKEN`，与本服务的网关令牌不是同一个
        'x-internal-token': this.config.mainToken ?? this.config.internalToken,
      },
      body: JSON.stringify({
        ownerType: input.ownerType,
        ownerId: input.ownerId,
        names: input.names,
        consumer: 'workspace-service',
      }),
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) throw new Error(`凭据解析失败：HTTP ${response.status}`)

    // main 的响应走统一信封 `{ code, data }`
    const body = (await response.json()) as {
      code: number
      data?: { items?: CredentialResolvedItem[] }
    }
    return body.data?.items ?? []
  }
}
