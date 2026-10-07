import { AuditEntity } from '@repo/kits'
import { AiModelSource } from '@repo/shared'
import { Column, Entity, Index } from 'typeorm'

/**
 * **AI 模型**（配置类数据）。
 *
 * 一行 = 某个供应商下的一个可调用模型。明细主要靠**供应商的"列模型"接口同步**拉回来
 * （国内厂商都提供 OpenAI 形态的 `GET {base}/models`，见 `modules/ai-model/provider-adapters.ts`），
 * 拉不全或想手工补时也能手工建（`source='manual'`）。
 *
 * 三条口径（详见设计文档 §4.8）：
 * - **`(provider_id, model_key)` 是同步的幂等锚点**：重复同步结果一致（upsert，不重复插入）；
 * - **`raw` 全量留存**供应商原始 JSON（不裁剪）：模型什么时候消失、参数什么时候变了可复盘；
 * - **`last_seen_at` 而不是"自动禁用"**：某次同步没返回某个模型，可能只是限流或权限变化 ——
 *   只记录"本次未见"，**绝不自动禁用**（误杀代价太大），下线与否由人决定。
 */
@Entity('ai_models')
// 同一供应商下 model_key 唯一（**软删感知**：删掉后可重新同步回来）
@Index('uk_model_provider_key', ['providerId', 'modelKey'], {
  unique: true,
  where: 'deleted_at IS NULL',
})
@Index('idx_model_provider', ['providerId'])
@Index('idx_model_enabled', ['enabled'])
export class AiModelEntity extends AuditEntity {
  /** 所属供应商（逻辑引用，无物理外键） */
  @Column({ name: 'provider_id', type: 'varchar', length: 20 })
  providerId!: string

  /** 供应商侧的模型 id（如 `deepseek-chat`；即供应商 `/models` 返回的 `data[].id`） */
  @Column({ name: 'model_key', type: 'varchar', length: 128 })
  modelKey!: string

  /** 展示名（OpenAI 形态的 `/models` 不返回展示名，缺省用 model_key） */
  @Column({ name: 'display_name', type: 'varchar', length: 128 })
  displayName!: string

  /** 上下文窗口（同步来的实测值；手工可改；将来供上下文策略优先使用） */
  @Column({ name: 'context_window', type: 'int', nullable: true })
  contextWindow: number | null = null

  /** 单次输出上限（OpenAI 形态的 `/models` 通常不返回，留 null；手工可改） */
  @Column({ name: 'max_output_tokens', type: 'int', nullable: true })
  maxOutputTokens: number | null = null

  /**
   * 模型类型（`chat` / `embedding` / `image_generation`…，对齐 LiteLLM 的 `mode`）。
   *
   * 为什么单独一列：agent 的模型选择器**只该列对话类** —— 没有这个字段时，
   * 一个 embedding 模型也能被选中，选中了必然报错。
   * 默认 `chat`：库里的老数据与手工新增都按对话模型处理（这是本工程的主要用途）。
   */
  @Column({ name: 'mode', type: 'varchar', length: 32, default: 'chat' })
  mode: string = 'chat'

  /**
   * **输入模态**（`["text","image","file"]`，取值见 `AiModality`），对齐 OpenRouter 的
   * `architecture.input_modalities`。
   *
   * 三态语义（长度 0 与 null 是两件事，别压成一种）：
   * - `null` = **未声明**（供应商没给、人也没填）→ 附件不拦，只提示；
   * - `[]` = 明确声明"什么输入都不支持"；
   * - `["text"]` = 明确只收文本 → 图片 / 文件要拦下并说清。
   *
   * 选数组而不是若干布尔：加一种模态不用改表，且与业界对外口径一致。
   */
  @Column({ name: 'input_modalities', type: 'jsonb', nullable: true })
  inputModalities: string[] | null = null

  /** 输出模态（同上；我们只做对话，所以实际取值基本就是 `["text"]`） */
  @Column({ name: 'output_modalities', type: 'jsonb', nullable: true })
  outputModalities: string[] | null = null

  /** 供应商原始能力标记（`tools` / `reasoning` / `methods`…；**给什么存什么、不编造**） */
  @Column({ name: 'capabilities', type: 'jsonb', nullable: true })
  capabilities: Record<string, unknown> | null = null

  /** 来源：见 `AiModelSource` 字典（`sync` 同步来的 / `manual` 手工补的；手工的同步不覆盖） */
  @Column({
    name: 'source',
    type: 'varchar',
    length: 16,
    default: AiModelSource._source.Sync.value,
  })
  source: string = AiModelSource._source.Sync.value

  /** 是否允许被选用（**用户的启停不被同步覆盖**） */
  @Column({ name: 'enabled', type: 'boolean', default: true })
  enabled = true

  /** 最后一次在供应商列表里出现的时间（"本次未返回"看它；null = 从未同步到） */
  @Column({ name: 'last_seen_at', type: 'timestamp', precision: 3, nullable: true })
  lastSeenAt: Date | null = null

  /** 最近一次被同步更新的时间 */
  @Column({ name: 'synced_at', type: 'timestamp', precision: 3, nullable: true })
  syncedAt: Date | null = null

  /** 供应商返回的原始字段（**全量留存、不裁剪**） */
  @Column({ name: 'raw', type: 'jsonb', nullable: true })
  raw: Record<string, unknown> | null = null
}
