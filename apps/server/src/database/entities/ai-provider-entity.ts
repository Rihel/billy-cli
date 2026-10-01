import { AuditEntity } from '@repo/kits'
import { AiProviderKind } from '@repo/shared'
import { Column, Entity, Index } from 'typeorm'

/**
 * **AI 模型供应商**（配置类数据）。
 *
 * 一行 = 一个"接入"：哪家、什么地址、什么密钥、启用没。它是"模型明细从哪来"的锚点 ——
 * `kind` 决定用哪家的"列模型"接口去拉（当前只收国内厂商 + OpenAI 兼容兜底，
 * 见 `modules/ai-model/provider-adapters.ts` 的 `PROVIDER_ENDPOINTS`）。
 *
 * 三条口径：
 * - **密钥明文入库**（`api_key`，2026-10-01 决定）：对外接口只回 `hintOf` 派生的提示串
 *   （见 `packages/shared` 的 `AiProviderSchema`），页面据此显示"配的是哪一把"；
 * - **唯一键是软删感知的**：`uk_provider_name ... WHERE deleted_at IS NULL` —— 否则删掉一个供应商后
 *   再建同名的会被历史行挡住（这是"软删 + 唯一约束"的经典坑）；
 * - 与 `ai_models` 是**逻辑引用**，不加物理外键（工程硬规则）。
 */
@Entity('ai_providers')
@Index('uk_provider_name', ['name'], {
  unique: true,
  where: 'deleted_at IS NULL',
})
// 模型对外标识的前半段（`<slug>/<modelKey>`）也必须是软删感知唯一的：
// 删掉一个供应商后重建同名 slug 不应被历史行挡住
@Index('uk_provider_slug', ['slug'], {
  unique: true,
  where: 'deleted_at IS NULL',
})
@Index('idx_provider_enabled', ['enabled'])
export class AiProviderEntity extends AuditEntity {
  /** 展示名（软删感知的唯一）：如「DeepSeek 官方」「自建网关」 */
  @Column({ name: 'name', type: 'varchar', length: 64 })
  name!: string

  /**
   * 机器可读标识（软删感知的唯一）：**ASCII 小写字母 / 数字 / 连字符**，
   * 如 `deepseek` / `my-gateway`。
   *
   * 它是模型对外标识的前半段 `'<slug>/<modelKey>'`，也是 Mastra 认识的 `provider/model` 形态；
   * 由服务层保证合法性（`name` 生成或调用方手填），表上不给默认值。
   */
  @Column({ name: 'slug', type: 'varchar', length: 32 })
  slug!: string

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

  /**
   * 密钥（**明文入库**，列名 `api_key`）。
   *
   * 工程取舍（2026-10-01 用户决定）：自建 / 内网场景下把"能否直接查库排障"排在"防库泄露"之前。
   * 代价如实记录：**库被读走就等于密钥泄露**。补偿只有两条：接口不回明文（只回
   * `hintOf` 派生的提示串），以及 `hasApiKey` 供页面判断"配没配"。
   */
  @Column({ name: 'api_key', type: 'text', nullable: true })
  apiKey: string | null = null


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
