import { Inject, Injectable } from '@nestjs/common'
import { MainInternalClient } from '@repo/internal-sdk'
import type { CredentialResolvedItem } from '@repo/contracts'
import {
  WorkspaceServiceConfig,
  type WorkspaceServiceConfigValue,
} from '../../config/app-config.js'
import { describeInternalFailure } from './main.client.js'

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
  private readonly client: MainInternalClient

  constructor(
    @Inject(WorkspaceServiceConfig) private readonly config: WorkspaceServiceConfigValue,
  ) {
    this.client = new MainInternalClient({
      baseUrl: config.mainUrl,
      // main 的 `/internal/*` 认 `TOOL_INTERNAL_TOKEN`，与本服务的网关令牌不是同一个
      token: config.mainToken ?? config.internalToken,
      timeoutMs: 15_000,
    })
  }

  async resolve(input: ResolveCredentialInput): Promise<CredentialResolvedItem[]> {
    if (input.names.length === 0) return []
    try {
      const result = await this.client.resolveCredentials({
        ownerType: input.ownerType,
        ownerId: input.ownerId,
        names: input.names,
        consumer: 'workspace-service',
      })
      return result.items
    } catch (error) {
      throw new Error(`凭据解析失败：${describeInternalFailure(error)}`)
    }
  }
}
