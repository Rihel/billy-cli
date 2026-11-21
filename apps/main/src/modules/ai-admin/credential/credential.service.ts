import { Inject, Injectable } from '@nestjs/common'
import { AppLogger } from '@repo/kits'
import {
  CredentialAuditAction,
  CredentialAuditConsumer,
  CredentialLifetime,
  CredentialRefresh,
  CredentialStatus,
  buildCredentialValuesSchema,
  credentialHintOf,
  credentialTemplateKeyOf,
  credentialTemplateOf,
  nanoid,
  splitCredentialValues,
  type CredentialBindDto,
  type CredentialIdDto,
  type CredentialListDto,
  type CredentialModel,
  type CredentialUpdateInjectDto,
  type CredentialInjectRule,
} from '@repo/shared'
import type { PersonalCredentialEntity } from '@repo/db'
import { currentOwner, scopeOf } from '../../../common/security/index.js'
import { CREDENTIAL_CONFIG, type CredentialModuleConfig } from './credential.config.js'
import { aadOfRow } from './credential-aad.js'
import { CredentialAuditRepository } from './credential-audit.repository.js'
import { CredentialSyncService } from './credential-sync.service.js'
import { PersonalCredentialRepository } from './credential.repository.js'
import {
  CredentialInvalidInputError,
  CredentialKeyNotConfiguredError,
  CredentialNameTakenError,
  CredentialNotFoundError,
  CredentialTemplateNotFoundError,
} from './credential.errors.js'

/**
 * 个人凭据的**管理面**（`docs/design/workspace-cli-credentials.md` §6.4）。
 *
 * 职责边界：
 * - 写入：按模板校验 → 拆 `config` / `secret` → 密文信封（AAD 绑行身份）→ 入库；
 * - 读取：对外模型**永不包含明文/密文**，只有 `config` 与 `secretHint`；
 * - 归属：一律经 `currentOwner()` + `scopeOf()`（超管可见全部元数据，普通管理员只能管自己的）；
 * - 明文纪律：`secret` 只在 `bind` / `reveal` 的单次调用内存在，不进日志与异常消息。
 */
@Injectable()
export class PersonalCredentialService {
  constructor(
    @Inject(PersonalCredentialRepository) private readonly repo: PersonalCredentialRepository,
    @Inject(CredentialAuditRepository) private readonly audit: CredentialAuditRepository,
    @Inject(CredentialSyncService) private readonly sync: CredentialSyncService,
    @Inject(CREDENTIAL_CONFIG) private readonly config: CredentialModuleConfig,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}

  async list(input: CredentialListDto): Promise<CredentialModel[]> {
    const rows = await this.repo.listByScope(scopeOf(currentOwner()))
    const keyword = input.keyword?.trim().toLowerCase()
    return rows
      .filter((row) => (input.provider ? row.provider === input.provider : true))
      .filter((row) =>
        keyword
          ? row.name.toLowerCase().includes(keyword) ||
            row.provider.toLowerCase().includes(keyword) ||
            (row.secretHint ?? '').toLowerCase().includes(keyword)
          : true,
      )
      .map((row) => this.toModel(row))
  }

  async detail(input: CredentialIdDto): Promise<CredentialModel> {
    return this.toModel(await this.requireOwned(input.credentialId))
  }

  /**
   * 绑定凭据：字段由模板定义，服务端按模板校验后加密。
   *
   * 两处刻意的取舍：
   * - `name` 冲突直接拒绝（覆盖等于替换别人的授权，必须由用户先确认再删旧建新，Q3）；
   * - 未配置主密钥直接失败 —— 宁可不保存，也不落明文。
   */
  async bind(input: CredentialBindDto): Promise<CredentialModel> {
    return this.createForOwner(currentOwner(), input, CredentialAuditConsumer.Web)
  }

  /**
   * 按**显式主体**创建凭据（内部导入用）：调用方已鉴权并确认归属，
   * 因此不再读请求上下文；审计 consumer 由调用方给出。
   */
  async importForOwner(
    owner: { ownerType: 'user' | 'admin'; ownerId: string },
    input: CredentialBindDto,
  ): Promise<CredentialModel> {
    return this.createForOwner(owner, input, CredentialAuditConsumer.WorkspaceService)
  }

  private async createForOwner(
    owner: { ownerType: 'user' | 'admin'; ownerId: string },
    input: CredentialBindDto,
    consumer: string,
  ): Promise<CredentialModel> {
    const template = credentialTemplateOf(input.provider, input.template)
    if (!template) throw new CredentialTemplateNotFoundError(input.provider, input.template)

    const parsed = buildCredentialValuesSchema(template).safeParse(input.values)
    if (!parsed.success) {
      // 只回模板的中文提示，绝不回字段值（可能含密码）；
      // **必须带字段键名** —— 执行面的模型只有看到 `appId：请填写…` 才知道该改哪个键
      throw new CredentialInvalidInputError(
        parsed.error.issues
          .map((issue) => `${issue.path.join('.') || 'values'}：${issue.message}`)
          .join('；'),
      )
    }

    const lifetime = input.lifetime ?? CredentialLifetime.LongTerm
    const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null
    if (lifetime === CredentialLifetime.Temporary && (!expiresAt || Number.isNaN(+expiresAt))) {
      throw new CredentialInvalidInputError('临时凭据必须填写到期时间')
    }
    if (!this.config.cipher.configured) throw new CredentialKeyNotConfiguredError()

    const name = input.name?.trim() || input.provider
    if (await this.repo.findByOwnerAndName(owner, name)) throw new CredentialNameTakenError(name)

    // schema 已补齐默认值（端口 / 库号 / 地域），parsed.data 就是最终入库形态
    const { config, secret } = splitCredentialValues(template, parsed.data)
    // 模板 key 才是持久化标识：同 provider 多模板（lark / lark-app）靠它区分
    const templateId = input.template?.trim() || credentialTemplateKeyOf(template)

    // id 必须先于加密产生：AAD 里有 id，密文与这一行的身份绑定
    const id = nanoid()
    const secretEnc = this.config.cipher.seal(
      secret,
      aadOfRow({ id, ...owner, provider: input.provider, template: templateId }),
    )

    const row = await this.repo.create({
      id,
      ownerType: owner.ownerType,
      ownerId: owner.ownerId,
      provider: input.provider,
      name,
      kind: template.kind,
      template: templateId,
      lifetime,
      refresh: template.kind === 'oauth' ? CredentialRefresh.Oauth : CredentialRefresh.None,
      expiresAt,
      secretEnc,
      secretHint: credentialHintOf(template, config, secret),
      config,
      inject: (input.inject ?? template.inject ?? []) satisfies CredentialInjectRule[],
      status: CredentialStatus.Active,
      lastUsedAt: null,
    })
    await this.audit
      .record({
        credentialId: row.id,
        owner,
        action: CredentialAuditAction.Issue,
        consumer,
        requestId: null,
        detail: { provider: row.provider, name: row.name, kind: row.kind },
      })
      .catch(() => undefined)
    // 传播到该用户全部运行中工作区（尽力而为 + 重试；ensure 时按版本兜底）
    void this.sync.push(owner, 'bind').catch((error: unknown) =>
      this.logger.warn('credential.sync_push_failed', {
        reason: error instanceof Error ? error.message : String(error),
      }),
    )
    this.logger.log('credential.bound', {
      id: row.id,
      provider: row.provider,
      ownerType: row.ownerType,
      ownerId: row.ownerId,
      lifetime: row.lifetime,
    })
    return this.toModel(row)
  }

  /**
   * 修改注入映射（文件 / 环境变量规则）。
   *
   * 只改 `inject`、不动凭据值与 AAD 字段：改 `provider` / `template` 等于换一份凭据，
   * 必须重新绑定（否则密文与身份不再对应）。
   */
  async updateInject(input: CredentialUpdateInjectDto): Promise<CredentialModel> {
    const row = await this.requireOwned(input.credentialId)
    const updated = await this.repo.update(row.id, { inject: input.inject })
    if (!updated) throw new CredentialNotFoundError(row.id)
    this.logger.log('credential.injectUpdated', { id: row.id, rules: input.inject.length })
    return this.toModel(updated)
  }

  /** 吊销：置 `revoked` 并软删（保留行便于审计与追溯；唯一名释放，可重新绑定） */
  async revoke(input: CredentialIdDto): Promise<{ removed: boolean }> {
    const row = await this.requireOwned(input.credentialId)
    await this.repo.update(row.id, { status: CredentialStatus.Revoked })
    await this.repo.softDelete(row.id)
    await this.audit
      .record({
        credentialId: row.id,
        owner: { ownerType: row.ownerType as 'user' | 'admin', ownerId: row.ownerId },
        action: CredentialAuditAction.Revoke,
        consumer: CredentialAuditConsumer.Web,
        requestId: null,
        detail: { provider: row.provider, name: row.name },
      })
      .catch(() => undefined)
    void this.sync
      .push({ ownerType: row.ownerType as 'user' | 'admin', ownerId: row.ownerId }, 'revoke')
      .catch((error: unknown) =>
        this.logger.warn('credential.sync_push_failed', {
          reason: error instanceof Error ? error.message : String(error),
        }),
      )
    this.logger.log('credential.revoked', { id: row.id, provider: row.provider })
    return { removed: true }
  }

  /**
   * 解密取用（**仅供平台内部消费方**：解析接口 / 注入阶段；不对外暴露）。
   *
   * 调用方负责归属判定（P4 的 resolve 只按调用人名下取），这里只做"解开这一行"。
   */
  async reveal(credentialId: string): Promise<{
    credential: PersonalCredentialEntity
    secret: Record<string, unknown>
  }> {
    const row = await this.repo.findById(credentialId)
    if (!row) throw new CredentialNotFoundError(credentialId)
    const secret = this.config.cipher.open<Record<string, unknown>>(row.secretEnc, aadOfRow(row))
    return { credential: row, secret }
  }

  /** 归属校验：越权与不存在同一个错误（避免探测他人凭据是否存在） */
  private async requireOwned(credentialId: string): Promise<PersonalCredentialEntity> {
    const row = await this.repo.findById(credentialId)
    if (!row) throw new CredentialNotFoundError(credentialId)
    const scope = scopeOf(currentOwner())
    if (scope.ownerType && (row.ownerType !== scope.ownerType || row.ownerId !== scope.ownerId)) {
      throw new CredentialNotFoundError(credentialId)
    }
    return row
  }

  /** 对外模型：**永不携带 `secretEnc` 与明文** */
  private toModel(row: PersonalCredentialEntity): CredentialModel {
    return {
      id: row.id,
      ownerType: row.ownerType as CredentialModel['ownerType'],
      ownerId: row.ownerId,
      provider: row.provider,
      name: row.name,
      kind: row.kind as CredentialModel['kind'],
      template: row.template,
      lifetime: row.lifetime as CredentialModel['lifetime'],
      refresh: row.refresh as CredentialModel['refresh'],
      expiresAt: row.expiresAt,
      secretHint: row.secretHint,
      config: row.config,
      inject: row.inject as CredentialModel['inject'],
      status: row.status as CredentialModel['status'],
      lastUsedAt: row.lastUsedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }
  }
}
