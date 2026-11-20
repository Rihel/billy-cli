import { Inject, Injectable } from '@nestjs/common'
import { Db } from '@repo/kits'
import { PersonalCredentialEntity } from '@repo/db'
import { CredentialStatus } from '@repo/shared'
import type { DeepPartial } from 'typeorm'
import type { OwnerRef, OwnerScope } from '../../../common/security/index.js'

/**
 * `personal_credentials` 的数据访问层。
 *
 * 两条纪律：
 * - **过滤条件由上层从 `scopeOf()` 取**（超管 `{}` = 不过滤），仓储不自己判超管；
 * - 仓储**不碰密文**：加密/解密在 service 层做，仓储只负责搬运 `secret_enc` 字符串。
 */
@Injectable()
export class PersonalCredentialRepository {
  constructor(@Inject(Db) private readonly db: Db) {}

  private repo() {
    return this.db.getRepository(PersonalCredentialEntity)
  }

  async findById(id: string): Promise<PersonalCredentialEntity | null> {
    return this.repo().findOne({ where: { id } })
  }

  /** 按归属过滤（`{}` 表示超管看全部） */
  async listByScope(scope: OwnerScope): Promise<PersonalCredentialEntity[]> {
    return this.repo().find({ where: scope, order: { createdAt: 'DESC' } })
  }

  /** 同一主体下按名字取（唯一索引已保证唯一，软删行不参与） */
  async findByOwnerAndName(
    owner: OwnerRef,
    name: string,
  ): Promise<PersonalCredentialEntity | null> {
    return this.repo().findOne({ where: { ...owner, name } })
  }

  /** 某主体某 provider 下可用的凭据（取最新的那条；多账号场景由调用方按 name 指定） */
  async findActiveByOwnerAndProvider(
    owner: OwnerRef,
    provider: string,
  ): Promise<PersonalCredentialEntity | null> {
    return this.repo().findOne({
      where: { ...owner, provider, status: CredentialStatus.Active },
      order: { updatedAt: 'DESC' },
    })
  }

  async create(data: DeepPartial<PersonalCredentialEntity>): Promise<PersonalCredentialEntity> {
    const repo = this.repo()
    return repo.save(repo.create(data))
  }

  async update(
    id: string,
    data: DeepPartial<PersonalCredentialEntity>,
  ): Promise<PersonalCredentialEntity | null> {
    const repo = this.repo()
    const existing = await repo.findOneBy({ id })
    if (!existing) return null
    Object.assign(existing, data)
    return repo.save(existing)
  }

  /** 软删（吊销保留行，便于审计与"为什么不能用"的追溯） */
  async softDelete(id: string): Promise<boolean> {
    const result = await this.repo().softDelete({ id })
    return (result.affected ?? 0) > 0
  }

  /** 主体可用凭据的版本信息（算 `credentialVersion`，与执行面同一函数） */
  async listActiveVersions(owner: OwnerRef): Promise<{ version: number }[]> {
    return this.repo().find({
      where: { ...owner, status: CredentialStatus.Active },
      select: { version: true },
    })
  }

  /** 记录一次消费（排查"这份凭据还有没有人用"；失败不影响主流程） */
  async touchLastUsed(id: string, at: Date = new Date()): Promise<void> {
    await this.repo().update({ id }, { lastUsedAt: at })
  }
}
