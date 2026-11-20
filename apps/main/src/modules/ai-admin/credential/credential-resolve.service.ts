import { Inject, Injectable } from '@nestjs/common'
import { AppLogger, RedisLockService, requestContext } from '@repo/kits'
import {
  CredentialAuditAction,
  CredentialAuditConsumer,
  CredentialKind,
  CredentialStatus,
  credentialHintOf,
  credentialTemplateOf,
} from '@repo/shared'
import type {
  CredentialResolveRequest,
  CredentialResolveResponse,
  CredentialResolvedItem,
} from '@repo/contracts'
import type { PersonalCredentialEntity } from '@repo/db'
import type { OwnerRef } from '../../../common/security/index.js'
import { CREDENTIAL_CONFIG, type CredentialModuleConfig } from './credential.config.js'
import { aadOfEntity } from './credential-aad.js'
import { CredentialAuditRepository } from './credential-audit.repository.js'
import { CredentialSyncService } from './credential-sync.service.js'
import { PersonalCredentialRepository } from './credential.repository.js'
import { CredentialRefreshRegistry, CredentialRefreshRejectedError } from './credential-refresh.js'
import { CredentialKeyNotConfiguredError } from './credential.errors.js'

/** 刷新提前量：到期前 15 分钟（§6.4.6），不是周期性全表扫描 */
const REFRESH_AHEAD_MS = 15 * 60 * 1000
/** 按用户串行刷新的锁：TTL 30s（看门狗续期），排队等待 10s */
const REFRESH_LOCK_TTL = 30
const REFRESH_LOCK_WAIT = 10

/**
 * **凭据解析与刷新**（`docs/design/workspace-cli-credentials.md` §6.4.6）。
 *
 * 放在 main 的原因：执行面不连 Redis，无法实现分布式锁，而「按用户串行刷新」是
 * 并发场景下避免 refresh token 相互作废的前提。
 *
 * 三条硬口径：
 * - **刷新按提前量触发**，成功后立即写回（同步通知留给 P6 的同步通道）；
 * - **失败分类**：确定性拒绝（`invalid_grant`）置 `expired`；网络 / 5xx 只记审计不降级；
 * - **运行时以 `expires_at` 为准**：`status='active'` 但时间已过，同样按不可用返回。
 */
@Injectable()
export class CredentialResolveService {
  constructor(
    @Inject(PersonalCredentialRepository) private readonly repo: PersonalCredentialRepository,
    @Inject(CredentialAuditRepository) private readonly audit: CredentialAuditRepository,
    @Inject(CREDENTIAL_CONFIG) private readonly config: CredentialModuleConfig,
    @Inject(CredentialRefreshRegistry) private readonly refresh: CredentialRefreshRegistry,
    @Inject(CredentialSyncService) private readonly sync: CredentialSyncService,
    @Inject(RedisLockService) private readonly locks: RedisLockService,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}

  async resolve(input: CredentialResolveRequest): Promise<CredentialResolveResponse> {
    if (!this.config.cipher.configured) throw new CredentialKeyNotConfiguredError()

    const items: CredentialResolvedItem[] = []
    for (const name of input.names) {
      items.push(await this.resolveOne(name, input))
    }
    return { items }
  }

  private async resolveOne(
    name: string,
    input: CredentialResolveRequest,
  ): Promise<CredentialResolvedItem> {
    const owner: OwnerRef = { ownerType: input.ownerType, ownerId: input.ownerId }
    const row = await this.repo.findByOwnerAndName(owner, name)
    if (!row) {
      await this.deny(input, name, null, 'missing')
      return this.itemOf({ name }, 'missing', null, '尚未绑定该凭据')
    }
    if (row.status === CredentialStatus.Revoked) {
      await this.deny(input, name, row.id, 'revoked')
      return this.itemOf(row, 'revoked', null, '凭据已吊销，请重新授权')
    }
    if (row.status === CredentialStatus.Expired) {
      await this.deny(input, name, row.id, 'expired')
      return this.itemOf(row, 'expired', null, '凭据已失效，请重新授权')
    }

    // OAuth 且临近过期：锁内二次查询 + 刷新（并发下只刷一次，后来者拿新值）
    let current = row
    if (this.shouldRefresh(current)) {
      current = await this.refreshWithLock(current).catch((error: unknown) => {
        this.logger.warn('credential.refresh.failed', {
          id: current.id,
          provider: current.provider,
          reason: error instanceof Error ? error.message : String(error),
        })
        return current
      })
    }

    if (current.status === CredentialStatus.Expired) {
      await this.deny(input, name, current.id, 'expired')
      return this.itemOf(current, 'expired', null, '凭据已失效，请重新授权')
    }
    // 运行时以 expires_at 为准：status 仍是 active 但时间已过，同样不可用
    if (this.expiredByTime(current)) {
      await this.deny(input, name, current.id, 'expired-at')
      return this.itemOf(current, 'expired', null, '凭据已过期，请重新授权')
    }

    const secret = this.openSecret(current)
    await this.audit
      .record({
        credentialId: current.id,
        owner,
        action: CredentialAuditAction.Resolve,
        consumer: input.consumer,
        requestId: this.requestIdOf(input),
        detail: { name, provider: current.provider },
      })
      .catch(() => undefined)
    void this.repo.touchLastUsed(current.id).catch(() => undefined)

    return this.itemOf(current, 'active', secret)
  }

  /**
   * 锁内刷新：按 **owner** 串行（不是按凭据）。
   *
   * 为什么按人而不是按凭据：同一用户的 refresh token 往往是同一份授权的多份副本，
   * 并发刷新会让先刷的那份使后刷的失效（Google / 飞书都会轮换 refresh token）。
   */
  private async refreshWithLock(
    current: PersonalCredentialEntity,
  ): Promise<PersonalCredentialEntity> {
    const key = `credential:refresh:${current.ownerType}:${current.ownerId}`
    return this.locks.withLock(key, REFRESH_LOCK_TTL, REFRESH_LOCK_WAIT, async () => {
      // 锁内二次查询：可能已被前一个持锁者刷新过
      const fresh = (await this.repo.findById(current.id)) ?? current
      if (!this.shouldRefresh(fresh)) return fresh

      const adapter = this.refresh.find(fresh.provider)
      // 没有适配器 = 平台不认识怎么刷：按现状使用，不假装成功
      if (!adapter) return fresh

      const owner: OwnerRef = {
        ownerType: fresh.ownerType as 'user' | 'admin',
        ownerId: fresh.ownerId,
      }
      try {
        const result = await adapter.refresh({
          secret: this.openSecret(fresh),
          config: fresh.config,
        })
        const secretEnc = this.config.cipher.seal(result.secret, aadOfEntity(fresh))
        const hint = this.hintOf(fresh, result.secret)
        const updated = await this.repo.update(fresh.id, {
          secretEnc,
          expiresAt: result.expiresAt,
          secretHint: hint,
          status: CredentialStatus.Active,
          // 真正的凭据变更：版本 +1（主体级 credentialVersion 由它派生）
          version: (fresh.version ?? 1) + 1,
        })
        await this.audit
          .record({
            credentialId: fresh.id,
            owner,
            action: CredentialAuditAction.Refresh,
            consumer: CredentialAuditConsumer.Main,
            requestId: requestContext.get('requestId') ?? null,
            detail: { provider: fresh.provider, outcome: 'refreshed' },
          })
          .catch(() => undefined)
        // 刷新成功后立即触发同步（§6.4.6）
        void this.sync.push(owner, 'refresh').catch(() => undefined)
        this.logger.log('credential.refreshed', {
          id: fresh.id,
          provider: fresh.provider,
          expiresAt: result.expiresAt.toISOString(),
        })
        return updated ?? fresh
      } catch (error) {
        if (error instanceof CredentialRefreshRejectedError) {
          // 确定性失效：置 expired，全工作区拒绝，提示重新授权
          const updated = await this.repo.update(fresh.id, { status: CredentialStatus.Expired })
          await this.audit
            .record({
              credentialId: fresh.id,
              owner,
              action: CredentialAuditAction.Refresh,
              consumer: CredentialAuditConsumer.Main,
              requestId: requestContext.get('requestId') ?? null,
              detail: { provider: fresh.provider, outcome: 'rejected', reason: error.reason },
            })
            .catch(() => undefined)
          return updated ?? fresh
        }
        // 临时故障（超时 / 5xx）：重试，不降级 —— 只记审计，凭据保持原状态
        await this.audit
          .record({
            credentialId: fresh.id,
            owner,
            action: CredentialAuditAction.Refresh,
            consumer: CredentialAuditConsumer.Main,
            requestId: requestContext.get('requestId') ?? null,
            detail: { provider: fresh.provider, outcome: 'transient' },
          })
          .catch(() => undefined)
        throw error
      }
    })
  }

  private shouldRefresh(row: PersonalCredentialEntity): boolean {
    if (row.kind !== CredentialKind.Oauth) return false
    if (!row.expiresAt) return false
    return row.expiresAt.getTime() - Date.now() <= REFRESH_AHEAD_MS
  }

  private expiredByTime(row: PersonalCredentialEntity): boolean {
    return row.expiresAt !== null && row.expiresAt.getTime() <= Date.now()
  }

  private openSecret(row: PersonalCredentialEntity): Record<string, unknown> {
    return this.config.cipher.open<Record<string, unknown>>(row.secretEnc, aadOfEntity(row))
  }

  /** 刷新后用模板重算提示值（refresh 会换掉 secret 字段，旧提示可能已无意义） */
  private hintOf(row: PersonalCredentialEntity, secret: Record<string, unknown>): string | null {
    const template = credentialTemplateOf(row.provider, row.template)
    if (!template) return row.secretHint
    return credentialHintOf(template, row.config, secret) ?? row.secretHint
  }

  private itemOf(
    row: {
      name: string
      provider?: string
      expiresAt?: Date | null
      config?: Record<string, unknown>
      inject?: unknown[]
    },
    status: CredentialResolvedItem['status'],
    secret: Record<string, unknown> | null,
    message?: string,
  ): CredentialResolvedItem {
    return {
      name: row.name,
      provider: row.provider ?? '',
      status,
      expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
      secret,
      config: row.config ?? {},
      inject: row.inject ?? [],
      ...(message ? { message } : {}),
    }
  }

  private async deny(
    input: CredentialResolveRequest,
    name: string,
    credentialId: string | null,
    reason: string,
  ): Promise<void> {
    await this.audit
      .record({
        credentialId,
        owner: { ownerType: input.ownerType, ownerId: input.ownerId },
        action: CredentialAuditAction.Deny,
        consumer: input.consumer,
        requestId: this.requestIdOf(input),
        detail: { name, reason },
      })
      .catch(() => undefined)
  }

  private requestIdOf(input: CredentialResolveRequest): string | null {
    return input.requestId ?? requestContext.get('requestId') ?? null
  }
}
