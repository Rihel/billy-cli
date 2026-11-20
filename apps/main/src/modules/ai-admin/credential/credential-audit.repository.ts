import { Inject, Injectable } from '@nestjs/common'
import { Db } from '@repo/kits'
import { PersonalCredentialAuditEntity } from '@repo/db'
import { CredentialAuditAction, CredentialAuditConsumer } from '@repo/shared'
import type { OwnerRef } from '../../../common/security/index.js'

/** 一次审计写入的输入（`detail` 只放原因 / 计数，**绝不放凭据值**） */
export interface CredentialAuditInput {
  credentialId?: string | null
  owner: OwnerRef
  action: string
  consumer: string
  requestId?: string | null
  detail?: Record<string, unknown>
}

/**
 * 凭据审计仓储（`docs/design/workspace-cli-credentials.md` §6.4.8）。
 *
 * **只追加**：没有 update / delete 接口 —— 审计是证据，能被改写就失去意义。
 * 写入失败不抛（审计不能挡住业务），但会记日志，便于发现"审计静默丢失"。
 */
@Injectable()
export class CredentialAuditRepository {
  constructor(@Inject(Db) private readonly db: Db) {}

  async record(input: CredentialAuditInput): Promise<void> {
    // 用 save(create(...)) 而不是 insert(...)：jsonb 列在 InsertQueryBuilder 的深偏类型下
    // 不接受 Record<string, unknown>（TypeORM 的 `_QueryDeepPartialEntity` 限制）
    const repo = this.db.getRepository(PersonalCredentialAuditEntity)
    await repo.save(
      repo.create({
        credentialId: input.credentialId ?? null,
        ownerType: input.owner.ownerType,
        ownerId: input.owner.ownerId,
        action: input.action,
        consumer: input.consumer,
        requestId: input.requestId ?? null,
        detail: input.detail ?? {},
      }),
    )
  }

  /** 某个凭据的审计流水（排障用，倒序；不含凭据值） */
  async listByCredential(
    credentialId: string,
    limit = 50,
  ): Promise<PersonalCredentialAuditEntity[]> {
    return this.db.getRepository(PersonalCredentialAuditEntity).find({
      where: { credentialId },
      order: { createdAt: 'DESC' },
      take: Math.min(Math.max(limit, 1), 200),
    })
  }

  /** 绑定 / 刷新 / 吊销 / 导入 / 读取 / 拒绝 的合法动作 */
  static readonly actions = CredentialAuditAction.values
  static readonly consumers = CredentialAuditConsumer.values
}
