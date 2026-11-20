import { Injectable } from '@nestjs/common'
import { AppErrorCodes } from '@repo/shared'
import { AppError } from '@repo/kits'

/**
 * **确定性失效**：上游明确拒绝（`invalid_grant` / `invalid_token`）。
 *
 * 只有这一类才把凭据置 `expired`；超时 / 连接失败 / 上游 5xx 属于临时故障，
 * 不得降级（§6.4.6）——单次网络抖动就让用户重新授权是不可接受的。
 */
export class CredentialRefreshRejectedError extends AppError {
  readonly code = AppErrorCodes.CredentialRefreshRejected
  constructor(
    readonly provider: string,
    readonly reason: string = 'invalid_grant',
  ) {
    super(`Credential refresh rejected: ${provider} (${reason})`)
  }
}

/** 刷新结果：新的密文字段 + 新的到期时间 */
export interface CredentialRefreshResult {
  secret: Record<string, unknown>
  expiresAt: Date
}

/**
 * OAuth 刷新适配器（按 provider 实现；v1 首批只有飞书，见 §9.2 的 P11）。
 *
 * 约定：**上游明确拒绝**时抛 `CredentialRefreshRejectedError`，
 * 其余失败（超时 / 5xx）直接抛原异常，由调用方按"可重试"处理。
 */
export interface CredentialRefreshAdapter {
  readonly provider: string
  refresh(input: {
    secret: Record<string, unknown>
    config: Record<string, unknown>
  }): Promise<CredentialRefreshResult>
}

/**
 * 刷新适配器注册表。
 *
 * 没有适配器的 provider **不刷新**（按现状使用）——这是刻意的：平台不假装能刷新
 * 它不认识的服务，用户看到的仍是库里那份凭据，失效时按 `expires_at` 拒绝。
 */
@Injectable()
export class CredentialRefreshRegistry {
  private readonly adapters = new Map<string, CredentialRefreshAdapter>()

  register(adapter: CredentialRefreshAdapter): void {
    this.adapters.set(adapter.provider, adapter)
  }

  find(provider: string): CredentialRefreshAdapter | undefined {
    return this.adapters.get(provider)
  }

  /** 已注册的 provider（排障 / 测试断言用） */
  providers(): string[] {
    return [...this.adapters.keys()].sort()
  }
}
