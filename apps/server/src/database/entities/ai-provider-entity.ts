import { AuditEntity } from '@repo/kits'
import { AiProviderKind } from '@repo/shared'
import { Column, Entity, Index } from 'typeorm'

/**
 * **AI 模型供应商**（配置类数据）。
 *
 * 一行 = 一个"接入"：哪家、什么地址、什么密钥、启用没。它是"模型明细从哪来"的锚点 ——
 * `kind` 决定用哪家的"列模型"接口去拉（OpenAI 兼容 / Anthropic / Gemini，见设计文档 §4.8.2）。
 *
 * 三条口径：
 * - **密钥只存密文**：`api_key_cipher`（AES-256-GCM），另存 `api_key_hint`（`sk-…abcd`）供人辨认；
 *   对外接口永不回传明文（见 `packages/shared` 的 `AiProviderSchema`）；
 * - **唯一键是软删感知的**：`uk_provider_name ... WHERE deleted_at IS NULL` —— 否则删掉一个供应商后
 *   再建同名的会被历史行挡住（这是"软删 + 唯一约束"的经典坑）；
 * - 与 `ai_models` 是**逻辑引用**，不加物理外键（工程硬规则）。
 */
@Entity('ai_providers')
@Index('uk_provider_name', ['name'], {
  unique: true,
  where: 'deleted_at IS NULL',
})
@Index('idx_provider_enabled', ['enabled'])
export class AiProviderEntity extends AuditEntity {
  /** 展示名（软删感知的唯一）：如「DeepSeek 官方」「自建网关」 */
  @Column({ name: 'name', type: 'varchar', length: 64 })
  name!: string

  /** 供应商类型：见 `AiProviderKind` 字典（决定用哪个"列模型"接口） */
  @Column({
    name: 'kind',
    type: 'varchar',
    length: 32,
    default: AiProviderKind._source.OpenaiCompatible.value,
  })
  kind: string = AiProviderKind._source.OpenaiCompatible.value

  /** 接口地址；留空表示用该 kind 的官方默认地址（自建网关 / 代理必须填） */
  @Column({ name: 'base_url', type: 'varchar', length: 255, nullable: true })
  baseUrl: string | null = null

  /** 密钥密文（AES-256-GCM：`base64(iv | tag | ciphertext)`；**明文不落库**） */
  @Column({ name: 'api_key_cipher', type: 'text', nullable: true })
  apiKeyCipher: string | null = null

  /** 密钥提示（`sk-…abcd`）：只够辨认"配的是哪一把" */
  @Column({ name: 'api_key_hint', type: 'varchar', length: 32, nullable: true })
  apiKeyHint: string | null = null

  /** 是否启用（禁用后不允许被选中，也不允许同步） */
  @Column({ name: 'enabled', type: 'boolean', default: true })
  enabled = true

  /** 最后一次**成功**同步模型明细的时间 */
  @Column({ name: 'last_synced_at', type: 'timestamp', precision: 3, nullable: true })
  lastSyncedAt: Date | null = null

  /** 最后一次同步失败原因（供应商原文；成功时清空）—— 排障要看原话 */
  @Column({ name: 'last_sync_error', type: 'text', nullable: true })
  lastSyncError: string | null = null

  /** 扩展位（组织 id、代理配置等） */
  @Column({ name: 'metadata', type: 'jsonb', nullable: true })
  metadata: Record<string, unknown> | null = null
}
