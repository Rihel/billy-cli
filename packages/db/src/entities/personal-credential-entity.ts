import {
  CredentialKind,
  CredentialLifetime,
  CredentialRefresh,
  CredentialStatus,
} from '@repo/shared'
import { BaseEntity } from '@repo/kits'
import { Column, Entity, Index } from 'typeorm'

/**
 * **个人凭据**（`docs/design/workspace-cli-credentials.md` §6.4.1）。
 *
 * 托管两类东西：可撤销的 OAuth 授权，以及数据库口令 / Redis 口令 / 云厂商 AK-SK 这类
 * 「对方本就没有授权机制」的静态凭据。它是**声明层资产**：绑定到吊销，永不依赖工作区存活。
 *
 * 五条与表结构绑定的口径：
 * - **密文列只有 `secret_enc`**：明文只在单次函数调用内驻留内存，不进日志 / 异常 / 序列化输出；
 * - **AAD 绑定 `id` + 归属 + `provider` + `template`**：这几个字段写入后不可改，
 *   改了必须重新加密，否则解密失败（正是防"密文搬运"的设计）；
 * - **`provider` / `name` 分开**：前者供代码匹配模板与适配器，后者供用户区分同名账号；
 * - **`kind` 只表达生命周期语义**（能否刷新），资源差异由 `template` 表达；
 * - **`status='expired'` 只在确定性失败时写**（`invalid_grant` / `invalid_token`），
 *   网络故障不得置为过期（§6.4.6）。
 */
@Entity('personal_credentials')
// 同一主体下凭据名唯一（软删感知：删掉后可以重建同名）
@Index('uk_credential_owner_name', ['ownerType', 'ownerId', 'name'], {
  unique: true,
  where: 'deleted_at IS NULL',
})
@Index('idx_credential_owner_provider', ['ownerType', 'ownerId', 'provider'])
// 到期巡检只扫"临时凭据的活行"：部分索引把长期凭据（永久非空过期时间）排除在外
@Index('idx_credential_expiry', ['status', 'expiresAt'], {
  where: "lifetime = 'temporary' AND deleted_at IS NULL",
})
export class PersonalCredentialEntity extends BaseEntity {
  /** 归属体系：`user` / `admin`（与工作区、技能同口径） */
  @Column({ name: 'owner_type', type: 'varchar', length: 8, default: 'user' })
  ownerType = 'user'

  /** 主体 id（逻辑引用，无物理外键） */
  @Column({ name: 'owner_id', type: 'varchar', length: 20 })
  ownerId!: string

  /** 资源标识（`lark` / `github` / `mysql` / `redis` / `tencent-cloud` …）：匹配模板与适配器 */
  @Column({ name: 'provider', type: 'varchar', length: 32 })
  provider!: string

  /** 用户命名的凭据名（同一 provider 可绑定多个账号） */
  @Column({ name: 'name', type: 'varchar', length: 64 })
  name!: string

  /** 生命周期语义：`static` 不刷新 / `oauth` 可刷新 / `ssh-key` 预留 */
  @Column({ name: 'kind', type: 'varchar', length: 16, default: CredentialKind.Static })
  kind: string = CredentialKind.Static

  /** 字段模板标识，缺省取 `provider` 同名模板 */
  @Column({ name: 'template', type: 'varchar', length: 32 })
  template!: string

  /** 库中记录的有效期口径：`long-term` / `temporary`（临时必须填 `expiresAt`） */
  @Column({ name: 'lifetime', type: 'varchar', length: 16, default: CredentialLifetime.LongTerm })
  lifetime: string = CredentialLifetime.LongTerm

  /** 刷新方式（仅对 `temporary` 有意义） */
  @Column({ name: 'refresh', type: 'varchar', length: 16, default: CredentialRefresh.None })
  refresh: string = CredentialRefresh.None

  /** 到期时间（`temporary` 时必填；运行时以它为准，`status` 只表达确定性失效） */
  @Column({ name: 'expires_at', type: 'timestamp', precision: 3, nullable: true })
  expiresAt: Date | null = null

  /** 密文信封：`v1:<keyId>:<iv>:<tag>:<ct>`（AES-256-GCM，AAD 见类注释） */
  @Column({ name: 'secret_enc', type: 'text' })
  secretEnc!: string

  /** 展示用标识（`root` / `AKID…abcd`），**不含完整值** */
  @Column({ name: 'secret_hint', type: 'varchar', length: 32, nullable: true })
  secretHint: string | null = null

  /** 模板里 `scope=config` 的字段（明文：host / port / database / username / region …） */
  @Column({ name: 'config', type: 'jsonb', default: () => "'{}'" })
  config: Record<string, unknown> = {}

  /** 注入规则（文件 / 环境变量），由用户或市场模板提供（§6.4.3） */
  @Column({ name: 'inject', type: 'jsonb', default: () => "'[]'" })
  inject: unknown[] = []

  /** `active` / `expired` / `revoked` */
  @Column({ name: 'status', type: 'varchar', length: 16, default: CredentialStatus.Active })
  status: string = CredentialStatus.Active

  /**
   * 凭据版本：**每次真正的变更 +1**（绑定 = 1，刷新 = 旧值 +1，吊销 = 软删不再参与）。
   *
   * 主体级 `credentialVersion` 由「活跃条数 + 最大 version」算出。
   * 刻意不用 `updated_at` 当版本：`last_used_at` 的触碰也会刷新 `updated_at`，
   * 会让每次解析都把版本顶高，工作区永远"落后"（踩过）。
   */
  @Column({ name: 'version', type: 'int', default: 1 })
  version = 1

  /** 最后一次被消费方取用的时间（排查"这份凭据还有没有人用"） */
  @Column({ name: 'last_used_at', type: 'timestamp', precision: 3, nullable: true })
  lastUsedAt: Date | null = null
}
