import {
  Db,
  pageWith,
  type PageQueryResult,
} from '@repo/kits'
import { AiModelSource } from '@repo/shared'
import type { AiModelListDto, AiProviderListDto } from '@repo/shared'
import { Inject, Injectable } from '@nestjs/common'
import { In, type DeepPartial } from 'typeorm'
import { isDeepStrictEqual } from 'node:util'
import { AiModelEntity } from '../../database/entities/ai-model-entity.js'
import { AiProviderEntity } from '../../database/entities/ai-provider-entity.js'

/**
 * AI 模型模块的数据访问层（供应商 + 模型两张表）。
 *
 * 三条与同步语义绑定的实现口径：
 * - **同步锚点是 `(provider_id, model_key)`**：`upsertSyncedModel` 存在则更新、不存在则插入，
 *   所以重复同步结果一致（幂等）；
 * - **`enabled` 不被同步覆盖**：更新时**刻意不写** `enabled`（用户的启停是人的决定）；
 * - **列表页的 `modelCount` 一次 group by 查完**：不在循环里逐个 count（防 N+1）。
 */

/** 一次同步要写入的模型明细（由 adapter 解析结果 + 同步时间组成） */
export interface UpsertSyncedModelInput {
  providerId: string
  modelKey: string
  displayName: string
  contextWindow: number | null
  maxOutputTokens: number | null
  capabilities: Record<string, unknown> | null
  /** 模型类型（见 `AiModelMode`） */
  mode: string
  /** 输入模态；`null` = 未声明（此时保留库里已有的值，见 `upsertSyncedModel`） */
  inputModalities: string[] | null
  /** 输出模态；同上 */
  outputModalities: string[] | null
  /** 供应商原始 JSON（全量留存，不裁剪） */
  raw: Record<string, unknown>
  /** 本次同步的时间戳（同时写 `syncedAt` 与 `lastSeenAt`） */
  syncedAt: Date
}

/** upsert 的结果分类（用于同步结果计数） */
export type UpsertSyncedModelResult = 'created' | 'updated' | 'unchanged'

/** "供应商启用 + 模型启用"的一行（运行时选模型用） */
export interface EnabledModelWithProvider {
  model: AiModelEntity
  provider: AiProviderEntity
}

/**
 * 比较 JSON 字段是否一致（决定算 updated 还是 unchanged）。
 *
 * 用 `isDeepStrictEqual` 而不是 `JSON.stringify`：**键顺序不同不算变化** ——
 * 供应商返回的 JSON 键顺序可能每次都不一样（HashMap 序列化），
 * 按字符串比会把每次同步都误判成 updated，计数立刻失去意义。
 */
const sameJson = (left: unknown, right: unknown): boolean =>
  isDeepStrictEqual(left ?? null, right ?? null)

@Injectable()
export class AiProviderRepository {
  constructor(@Inject(Db) private readonly db: Db) {}

  private repo() {
    return this.db.getRepository(AiProviderEntity)
  }

  /** 分页（按创建时间倒序；`id` 兜底保证顺序稳定） */
  async page(input: AiProviderListDto): Promise<PageQueryResult<AiProviderEntity>> {
    const { page, size } = input
    const repo = await this.repo()
    const builder = repo
      .createQueryBuilder('p')
      .orderBy('p.created_at', 'DESC')
      .addOrderBy('p.id', 'DESC')
    const { data, total } = await pageWith(builder, page, size)
    return { items: data, total, page, size }
  }

  async findById(id: string): Promise<AiProviderEntity | null> {
    const repo = await this.repo()
    return repo.findOneBy({ id })
  }

  /** 按展示名查找（唯一性校验用；软删行不参与） */
  async findByName(name: string): Promise<AiProviderEntity | null> {
    const repo = await this.repo()
    return repo.findOneBy({ name })
  }

  /** 按 slug 查找（slug 生成 / 唯一性校验用） */
  async findBySlug(slug: string): Promise<AiProviderEntity | null> {
    const repo = await this.repo()
    return repo.findOneBy({ slug })
  }

  /**
   * 供应商总数。
   *
   * `withDeleted: true`：**连软删的历史行一起数** —— 种子初始化只在"库里从来没有过供应商"
   * 时执行，否则人主动删掉全部供应商后，一次重启就会把它们原样种回来。
   */
  async countIncludingDeleted(): Promise<number> {
    const repo = await this.repo()
    return repo.count({ withDeleted: true })
  }

  async create(data: DeepPartial<AiProviderEntity>): Promise<AiProviderEntity> {
    const repo = await this.repo()
    return repo.save(repo.create(data))
  }

  async update(id: string, data: DeepPartial<AiProviderEntity>): Promise<AiProviderEntity | null> {
    const repo = await this.repo()
    const existing = await repo.findOneBy({ id })
    if (!existing) return null
    Object.assign(existing, data)
    return repo.save(existing)
  }

  /**
   * 软删供应商。
   *
   * 用 `softRemove`（而不是 `softDelete`）：前者走实体事件，`AuditSubscriber.beforeSoftRemove`
   * 才会把 `deleted_by` 写上（本工程审计列的既定做法）。
   */
  async softDelete(id: string): Promise<void> {
    const repo = await this.repo()
    const existing = await repo.findOneBy({ id })
    if (!existing) return
    await repo.softRemove(existing)
  }
}

@Injectable()
export class AiModelRepository {
  constructor(@Inject(Db) private readonly db: Db) {}

  private repo() {
    return this.db.getRepository(AiModelEntity)
  }

  private providerRepo() {
    return this.db.getRepository(AiProviderEntity)
  }

  /** 分页（按 `modelKey` 正序；`keyword` 走 ILIKE 过滤 `model_key`） */
  async page(input: AiModelListDto): Promise<PageQueryResult<AiModelEntity>> {
    const { page, size, providerId, keyword } = input
    const repo = await this.repo()
    const builder = repo
      .createQueryBuilder('m')
      .where('m.provider_id = :providerId', { providerId })
    if (keyword) {
      builder.andWhere('m.model_key ILIKE :keyword', { keyword: `%${keyword}%` })
    }
    builder.orderBy('m.model_key', 'ASC').addOrderBy('m.id', 'ASC')
    const { data, total } = await pageWith(builder, page, size)
    return { items: data, total, page, size }
  }

  async findById(id: string): Promise<AiModelEntity | null> {
    const repo = await this.repo()
    return repo.findOneBy({ id })
  }

  /** 同步锚点：`(provider_id, model_key)` 查一行（软删行不参与） */
  async findByProviderAndKey(providerId: string, modelKey: string): Promise<AiModelEntity | null> {
    const repo = await this.repo()
    return repo.findOneBy({ providerId, modelKey })
  }

  /** 某供应商下的全部模型（软删行不计）。同步流程用它一次性取回，避免逐个查询 */
  async listByProvider(providerId: string): Promise<AiModelEntity[]> {
    const repo = await this.repo()
    return repo.find({ where: { providerId }, order: { modelKey: 'ASC' } })
  }

  /** 某供应商下的模型数（软删行不计） */
  async countModels(providerId: string): Promise<number> {
    const repo = await this.repo()
    return repo.count({ where: { providerId } })
  }

  /**
   * 全部供应商的模型数（列表页 `modelCount` 用）。
   *
   * **一次 group by 查完**，不要在供应商列表上逐个 `countModels` —— 那是标准的 N+1。
   */
  async countModelsByProvider(): Promise<Map<string, number>> {
    const repo = await this.repo()
    const rows = await repo
      .createQueryBuilder('m')
      .select('m.provider_id', 'providerId')
      .addSelect('COUNT(*)', 'count')
      .groupBy('m.provider_id')
      .getRawMany<{ providerId: string; count: string }>()
    return new Map(rows.map((row) => [row.providerId, Number(row.count)]))
  }

  async create(data: DeepPartial<AiModelEntity>): Promise<AiModelEntity> {
    const repo = await this.repo()
    return repo.save(repo.create(data))
  }

  async update(id: string, data: DeepPartial<AiModelEntity>): Promise<AiModelEntity | null> {
    const repo = await this.repo()
    const existing = await repo.findOneBy({ id })
    if (!existing) return null
    Object.assign(existing, data)
    return repo.save(existing)
  }

  /**
   * 同步落一行模型明细（幂等 upsert，锚点 = `(providerId, modelKey)`）。
   *
   * 行为（设计文档 §4.8.3）：
   * - 不存在 → 插入，`source='sync'`、`enabled=true`，返回 `created`；
   * - 已存在 → 只更新 `display_name` / 窗口 / `mode` / 模态 / `capabilities` / `raw` /
   *   `synced_at` / `last_seen_at`，**绝不动 `enabled`**（用户的启停不被同步覆盖）；
   *   内容没变时返回 `unchanged`、变了返回 `updated`；
   * - **模态是"同步给了才覆盖"**：供应商没给（`null`）时保留库里已有的值 —— 那多半是人手工填的
   *   （国内厂商普遍不给模态信息），被一次同步抹掉的话，附件能力会悄悄退回"未声明"；
   * - 已存在但 `source='manual'`（手工补的）→ **同步完全不碰**（用户自己填的窗口 / 展示名优先），
   *   返回 `unchanged`。
   */
  async upsertSyncedModel(input: UpsertSyncedModelInput): Promise<UpsertSyncedModelResult> {
    const repo = await this.repo()
    const existing = await repo.findOneBy({
      providerId: input.providerId,
      modelKey: input.modelKey,
    })

    if (!existing) {
      await repo.save(
        repo.create({
          providerId: input.providerId,
          modelKey: input.modelKey,
          displayName: input.displayName,
          contextWindow: input.contextWindow,
          maxOutputTokens: input.maxOutputTokens,
          mode: input.mode,
          inputModalities: input.inputModalities,
          outputModalities: input.outputModalities,
          capabilities: input.capabilities,
          source: AiModelSource.Sync,
          enabled: true,
          lastSeenAt: input.syncedAt,
          syncedAt: input.syncedAt,
          raw: input.raw,
        }),
      )
      return 'created'
    }

    // 手工补的模型：同步不碰（连 last_seen_at 都不改，否则"本次未返回"的口径会被污染）
    if (existing.source === AiModelSource.Manual) return 'unchanged'

    /**
     * **"同步给了就用同步的，没给就保留库里的"**（模态 / 窗口同类）。
     *
     * 窗口为什么必须与模态同口径：多数厂商的 `/models` 还是老形态（不给窗口），
     * 人手工填的那个值就是**唯一的数据源**；若同步拿 `null` 直接覆盖，
     * 每次同步都把人的判断抹掉 —— 而这条数据偏偏是上下文裁剪策略的唯一输入。
     */
    const nextInputModalities = input.inputModalities ?? existing.inputModalities
    const nextOutputModalities = input.outputModalities ?? existing.outputModalities
    const nextContextWindow = input.contextWindow ?? existing.contextWindow
    const nextMaxOutputTokens = input.maxOutputTokens ?? existing.maxOutputTokens

    const unchanged =
      existing.displayName === input.displayName &&
      existing.contextWindow === nextContextWindow &&
      existing.maxOutputTokens === nextMaxOutputTokens &&
      existing.mode === input.mode &&
      sameJson(existing.inputModalities, nextInputModalities) &&
      sameJson(existing.outputModalities, nextOutputModalities) &&
      sameJson(existing.capabilities, input.capabilities) &&
      sameJson(existing.raw, input.raw)

    // 即便内容没变也要刷 synced_at / last_seen_at：它们记录的是"本次见到过"
    existing.displayName = input.displayName
    existing.contextWindow = nextContextWindow
    existing.maxOutputTokens = nextMaxOutputTokens
    existing.mode = input.mode
    existing.inputModalities = nextInputModalities
    existing.outputModalities = nextOutputModalities
    existing.capabilities = input.capabilities
    existing.raw = input.raw
    existing.syncedAt = input.syncedAt
    existing.lastSeenAt = input.syncedAt
    await repo.save(existing)
    return unchanged ? 'unchanged' : 'updated'
  }

  /**
   * "本次同步未返回"的既有模型数（只提示，**绝不自动禁用** —— 限流就会误杀）。
   *
   * 判据：本次同步的 `syncedAt` 之前没被见到过（`last_seen_at` 为空或更早）。
   * **排除 `source='manual'`**：手工补的模型本来就不会出现在供应商列表里，
   * 计入只会让这个数字永远非零、失去信号意义。
   */
  async modelsNotSeenSince(providerId: string, syncedAt: Date): Promise<number> {
    const repo = await this.repo()
    return repo
      .createQueryBuilder('m')
      .where('m.provider_id = :providerId', { providerId })
      .andWhere('m.source != :manual', { manual: AiModelSource.Manual })
      .andWhere('(m.last_seen_at IS NULL OR m.last_seen_at < :syncedAt)', { syncedAt })
      .getCount()
  }

  /** 软删某供应商下的全部模型（`provider/remove` 用；审计列由 AuditSubscriber 写） */
  async softDeleteByProviderId(providerId: string): Promise<void> {
    const repo = await this.repo()
    const rows = await repo.findBy({ providerId })
    if (rows.length === 0) return
    await repo.softRemove(rows)
  }

  /** 软删单个模型 */
  async softDelete(id: string): Promise<void> {
    const repo = await this.repo()
    const existing = await repo.findOneBy({ id })
    if (!existing) return
    await repo.softRemove(existing)
  }

  /**
   * "供应商启用 + 模型启用"的全部模型（**运行时唯一的模型来源**，见 §4.9）。
   *
   * 排序即"未显式选择时用的那个"：供应商创建时间升序 → `model_key` 升序。
   * 两步查询（模型 join 过滤 + 按 id 批量取供应商）而不是 N+1：
   * `AiModelEntity` 与 `AiProviderEntity` 之间没有 TypeORM relation（工程不加物理外键，
   * 也不为此引入虚拟 relation），所以 join 条件只用于筛选、供应商行单独一次 `In(...)` 取回。
   */
  async listEnabledWithProvider(): Promise<EnabledModelWithProvider[]> {
    const repo = await this.repo()
    const models = await repo
      .createQueryBuilder('m')
      .innerJoin(AiProviderEntity, 'p', 'p.id = m.provider_id AND p.deleted_at IS NULL')
      .where('m.enabled = :enabled', { enabled: true })
      .andWhere('p.enabled = :enabled', { enabled: true })
      .orderBy('p.created_at', 'ASC')
      .addOrderBy('m.model_key', 'ASC')
      .getMany()
    if (models.length === 0) return []

    const providerIds = [...new Set(models.map((model) => model.providerId))]
    const providers = await this.providerRepo().findBy({ id: In(providerIds) })
    const providerById = new Map(providers.map((provider) => [provider.id, provider]))
    return models.flatMap((model) => {
      const provider = providerById.get(model.providerId)
      return provider ? [{ model, provider }] : []
    })
  }
}
