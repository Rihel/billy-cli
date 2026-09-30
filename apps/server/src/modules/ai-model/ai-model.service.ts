import { AppLogger, Transactional, type PageQueryResult } from '@repo/kits'
import { AiModelSource } from '@repo/shared'
import type {
  AiAvailableModelListModel,
  AiAvailableModelModel,
  AiModelCreateDto,
  AiModelIdDto,
  AiModelListDto,
  AiModelModel,
  AiModelUpdateDto,
  AiProviderCreateDto,
  AiProviderIdDto,
  AiProviderListDto,
  AiProviderModel,
  AiProviderSyncResultModel,
  AiProviderTestDto,
  AiProviderTestResultModel,
  AiProviderUpdateDto,
} from '@repo/shared'
import { Inject, Injectable } from '@nestjs/common'
import type { DeepPartial } from 'typeorm'
import { AiModelEntity } from '../../database/entities/ai-model-entity.js'
import { AiProviderEntity } from '../../database/entities/ai-provider-entity.js'
import { AiModelRepository, AiProviderRepository } from './ai-model.repository.js'
import {
  ModelKeyTakenError,
  ModelNotFoundError,
  ModelNotConfiguredError,
  ModelSyncFailedError,
  ProviderDisabledError,
  ProviderKeyUnavailableError,
  ProviderNameTakenError,
  ProviderNotFoundError,
  ProviderSlugInvalidError,
} from './errors.js'
import { decryptSecret, encryptSecret, hintOf, resolveEncryptionSecret } from './model-secret.js'
import { listProviderModels, type ListProviderModelsResult } from './provider-adapters.js'

/**
 * 本模块的配置分片（由 `AI_MODEL_CONFIG` 注入）。
 *
 * token 定义在 service 文件而不是 module 文件：module 需要 import service 拿类，
 * 若 token 反过来定义在 module 里就会形成 **module ⇄ service 循环 import**，
 * 而装饰器 `@Inject(token)` 在类定义期求值，循环导入会直接撞上 TDZ 报错。
 */
export interface AiModelConfig {
  /** 密钥加密口令（`AI_MODEL_ENCRYPTION_KEY`）；缺省回落 `jwt.secret` */
  encryptionKey?: string
  /** 回落口令（通常是 `jwt.secret`） */
  fallbackSecret?: string
  /** 是否允许首次启动时用环境变量种子初始化（`AGENT_SEED_FROM_ENV`，默认 true） */
  seedFromEnv: boolean
}

/** 配置注入 token */
export const AI_MODEL_CONFIG = Symbol.for('AiModelConfig')

/**
 * 运行时解析出来的模型（**这一轮对话真正要用的东西**，见设计文档 §4.9）。
 *
 * 与 `modules/ai/core` 的 `RuntimeModel` **结构一致**（那边刻意不 import 本模块的类型）。
 */
export interface ResolvedRuntimeModel {
  /** ai_models.id */
  id: string
  /** `<provider.slug>/<modelKey>`（Mastra 的模型标识形态） */
  modelRef: string
  modelKey: string
  displayName: string
  /** 供应商地址（留空走官方端点） */
  baseURL?: string
  /**
   * 供应商类型（`ai_providers.kind`）。
   *
   * 运行时**靠它决定走官方适配还是通用 OpenAI 兼容**（见 `usesOfficialAdapter`）——
   * 刻意不用 `modelRef` 的前缀：那是 slug（人能改、还能撞名），只有 `kind` 是权威字段。
   */
  providerKind: string
  /** 解密后的密钥（**只在内存里流转，绝不落库 / 回传**） */
  apiKey: string
  contextWindow: number | null
}

/** 对外供应商模型（额外带 `modelCount`：列表页要显示"这家有几个模型"） */
export type AiProviderViewModel = AiProviderModel & { modelCount: number }

/** slug 自动生成：只保留 ASCII 小写字母 / 数字，其余折叠成单个连字符 */
const slugFromName = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)

/** slug 冲突时的重试上限（`-2` … `-20`） */
const SLUG_MAX_ATTEMPTS = 20

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/**
 * AI 模型模块的业务层：供应商 / 模型的增删改查 + "从供应商接口拉模型明细" + 运行时解析模型。
 *
 * 三条贯穿全文件的硬口径：
 * - **密钥只进不出**：入参 `apiKey` 加密后落库，对外模型只有 `apiKeyHint` / `hasApiKey`，
 *   明文既不落库也不回传（`ResolvedRuntimeModel.apiKey` 只在内存里交给 Mastra）；
 * - **同步幂等且不夺权**：`(providerId, modelKey)` upsert；`enabled` 永不被同步覆盖，
 *   本次未返回的模型只提示不动它（§4.8.3）；
 * - **运行时只用库里的模型**：`resolveForRuntime` 没有任何环境变量兜底路径，
 *   库空就是 3406（§4.9）。
 */
@Injectable()
export class AiModelService {
  constructor(
    @Inject(AiProviderRepository) private readonly providers: AiProviderRepository,
    @Inject(AiModelRepository) private readonly models: AiModelRepository,
    @Inject(AI_MODEL_CONFIG) private readonly config: AiModelConfig,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}

  // ─────────────────────────────── 供应商 ───────────────────────────────

  /** 供应商分页（带 modelCount，一次 group by 查完，无 N+1） */
  async listProviders(input: AiProviderListDto): Promise<PageQueryResult<AiProviderModel>> {
    const page = await this.providers.page(input)
    const counts = await this.models.countModelsByProvider()
    return {
      ...page,
      items: page.items.map((item) => this.toProviderModel(item, counts.get(item.id) ?? 0)),
    }
  }

  /** 新建供应商：`slug` 留空由名称生成；密钥加密入库，响应只回提示 */
  @Transactional()
  async createProvider(input: AiProviderCreateDto): Promise<AiProviderModel> {
    await this.assertNameAvailable(input.name)
    const slug = await this.allocateSlug(slugFromName(input.name))
    const apiKey = input.apiKey?.trim()
    const record = await this.providers.create({
      name: input.name,
      kind: input.kind,
      slug,
      baseUrl: input.baseUrl ?? null,
      apiKeyCipher: apiKey ? encryptSecret(apiKey, this.requireSecret()) : null,
      apiKeyHint: apiKey ? hintOf(apiKey) : null,
      enabled: input.enabled ?? true,
    })
    this.logger.log('ai-model.provider.created', {
      id: record.id,
      name: record.name,
      slug: record.slug,
      hasApiKey: Boolean(record.apiKeyCipher),
    })
    return this.toProviderModel(record, 0)
  }

  async detailProvider(input: AiProviderIdDto): Promise<AiProviderModel> {
    const record = await this.requireProvider(input.providerId)
    return this.toProviderModel(record, await this.models.countModels(record.id))
  }

  /**
   * 更新供应商（**三态语义**，前端按此传参，必须严格对齐）：
   * - `apiKey`：`undefined`（省略）= **不改**；`''` = **清空**（`apiKeyCipher` 与 `apiKeyHint` 一起置 null）；
   *   有值 = 加密覆盖；
   * - `baseUrl`：`undefined` = **不改**；`null` = **清空**（落库 NULL，回到该 kind 的官方默认地址）；
   *   字符串 = 覆盖；
   * - `slug` / `name`：改动时都做软删感知的唯一性检查，冲突给可读错误（不让 23505 冒到 HTTP 边界）。
   *
   * 换 `kind` / `baseUrl` 不影响已有模型明细（下次同步才拉新的）。
   */
  @Transactional()
  async updateProvider(input: AiProviderUpdateDto): Promise<AiProviderModel> {
    const existing = await this.requireProvider(input.providerId)
    const changes: DeepPartial<AiProviderEntity> = {}

    if (input.name !== undefined && input.name !== existing.name) {
      await this.assertNameAvailable(input.name, existing.id)
      changes.name = input.name
    }
    if (input.kind !== undefined) changes.kind = input.kind
    if (input.slug !== undefined && input.slug !== existing.slug) {
      const owner = await this.providers.findBySlug(input.slug)
      if (owner && owner.id !== existing.id) {
        throw new ProviderSlugInvalidError(`slug「${input.slug}」已被供应商「${owner.name}」占用`)
      }
      changes.slug = input.slug
    }
    // `undefined` 不改、`null` 清空、字符串覆盖 —— 三种语义都必须能区分出来
    if (input.baseUrl !== undefined) changes.baseUrl = input.baseUrl
    if (input.enabled !== undefined) changes.enabled = input.enabled
    if (input.apiKey !== undefined) {
      const apiKey = input.apiKey.trim()
      if (apiKey) {
        changes.apiKeyCipher = encryptSecret(apiKey, this.requireSecret())
        changes.apiKeyHint = hintOf(apiKey)
      } else {
        changes.apiKeyCipher = null
        changes.apiKeyHint = null
      }
    }

    const record = await this.providers.update(existing.id, changes)
    if (!record) throw new ProviderNotFoundError(input.providerId)
    this.logger.log('ai-model.provider.updated', {
      id: record.id,
      slug: record.slug,
      apiKeyChanged: input.apiKey !== undefined,
    })
    return this.toProviderModel(record, await this.models.countModels(record.id))
  }

  /** 软删供应商：其下模型**同一事务**一并软删（配置类数据保留历史，便于复盘） */
  @Transactional()
  async removeProvider(input: AiProviderIdDto): Promise<void> {
    const existing = await this.requireProvider(input.providerId)
    await this.models.softDeleteByProviderId(existing.id)
    await this.providers.softDelete(existing.id)
    this.logger.log('ai-model.provider.removed', { id: existing.id, slug: existing.slug })
  }

  /**
   * 从供应商接口拉模型明细（**幂等**：重复执行结果一致）。
   *
   * 失败处理：供应商原文写进 `last_sync_error` 并抛 3403；成功则清空并写 `last_synced_at`。
   * 刻意**不加 `@Transactional`**：网络请求不能包在数据库事务里（一个卡死的网关会长时间占着连接）。
   */
  async syncProvider(input: AiProviderIdDto): Promise<AiProviderSyncResultModel> {
    const provider = await this.requireProvider(input.providerId)
    if (!provider.enabled) throw new ProviderDisabledError(provider.id)
    if (!provider.apiKeyCipher) {
      throw new ModelSyncFailedError(
        `供应商「${provider.name}」未配置密钥，无法拉取模型明细；请先在「编辑供应商」里填入 API Key`,
      )
    }
    const apiKey = this.decryptProviderKey(provider)

    const syncedAt = new Date()
    let listing: ListProviderModelsResult
    try {
      listing = await listProviderModels({
        kind: provider.kind,
        baseUrl: provider.baseUrl,
        apiKey,
      })
    } catch (error) {
      const reason = messageOf(error)
      const endpoint = error instanceof ModelSyncFailedError ? error.endpoint : ''
      // 供应商原文落库：成功前它一直是"最近一次失败原因"（页面直接展示）
      await this.providers.update(provider.id, { lastSyncError: reason })
      this.logger.error('ai-model.provider.sync.failed', { id: provider.id, endpoint, error })
      throw new ModelSyncFailedError(`同步供应商「${provider.name}」模型明细失败：${reason}`)
    }
    const { endpoint } = listing

    // 去重（供应商偶尔返回重复 id）：计数与 upsert 都以唯一 modelKey 为准
    const uniqueModels = [...new Map(listing.models.map((model) => [model.modelKey, model])).values()]
    let created = 0
    let updated = 0
    let unchanged = 0
    for (const model of uniqueModels) {
      const result = await this.models.upsertSyncedModel({
        providerId: provider.id,
        modelKey: model.modelKey,
        displayName: model.displayName ?? model.modelKey,
        contextWindow: model.contextWindow ?? null,
        maxOutputTokens: model.maxOutputTokens ?? null,
        capabilities: model.capabilities ?? null,
        raw: model.raw,
        syncedAt,
      })
      if (result === 'created') created += 1
      else if (result === 'updated') updated += 1
      else unchanged += 1
    }

    const missing = await this.models.modelsNotSeenSince(provider.id, syncedAt)
    await this.providers.update(provider.id, { lastSyncedAt: syncedAt, lastSyncError: null })

    const result: AiProviderSyncResultModel = {
      providerId: provider.id,
      created,
      updated,
      unchanged,
      missing,
      total: uniqueModels.length,
      syncedAt,
    }
    this.logger.log('ai-model.provider.synced', { ...result, endpoint })
    return result
  }

  /**
   * 连通性测试：**只测不落库**（配错了当场知道）。
   *
   * 支持"未保存先测"：给了 `providerId` 且没显式传密钥时，用库里已存的密钥解密来测。
   * 失败不抛异常，而是回 `{ ok: false, error, endpoint }` —— 它就是给用户看结果的接口。
   */
  async testProvider(input: AiProviderTestDto): Promise<AiProviderTestResultModel> {
    const startedAt = Date.now()
    const done = (result: Omit<AiProviderTestResultModel, 'durationMs'>) => ({
      ...result,
      durationMs: Date.now() - startedAt,
    })

    let kind = input.kind
    let baseUrl = input.baseUrl
    let apiKey = input.apiKey?.trim() || undefined

    if (input.providerId) {
      const provider = await this.requireProvider(input.providerId)
      kind = input.kind ?? provider.kind
      if (baseUrl === undefined) baseUrl = provider.baseUrl ?? undefined
      if (!apiKey && provider.apiKeyCipher) apiKey = this.decryptProviderKey(provider)
    }

    if (!apiKey) {
      return done({
        ok: false,
        modelCount: 0,
        error: '未提供 API Key：请填写后测试，或先保存供应商再点测试',
        endpoint: '',
      })
    }

    try {
      const listing = await listProviderModels({ kind, baseUrl, apiKey })
      return done({
        ok: true,
        modelCount: listing.models.length,
        error: null,
        endpoint: listing.endpoint,
      })
    } catch (error) {
      return done({
        ok: false,
        modelCount: 0,
        error: messageOf(error),
        endpoint: error instanceof ModelSyncFailedError ? error.endpoint : '',
      })
    }
  }

  // ─────────────────────────────── 模型 ───────────────────────────────

  /** 某供应商下的模型分页（`keyword` 过滤 `modelKey`） */
  async listModels(input: AiModelListDto): Promise<PageQueryResult<AiModelModel>> {
    const page = await this.models.page(input)
    return { ...page, items: page.items.map((item) => this.toModelModel(item)) }
  }

  /** 手工新增模型（`source='manual'`：同步不覆盖，用户自己填的窗口 / 展示名优先） */
  @Transactional()
  async createModel(input: AiModelCreateDto): Promise<AiModelModel> {
    await this.requireProvider(input.providerId)
    const existing = await this.models.findByProviderAndKey(input.providerId, input.modelKey)
    if (existing) throw new ModelKeyTakenError(input.providerId, input.modelKey)

    const record = await this.models.create({
      providerId: input.providerId,
      modelKey: input.modelKey,
      displayName: input.displayName ?? input.modelKey,
      contextWindow: input.contextWindow ?? null,
      maxOutputTokens: input.maxOutputTokens ?? null,
      source: AiModelSource.Manual,
      enabled: input.enabled ?? true,
      lastSeenAt: null,
      syncedAt: null,
      raw: null,
    })
    this.logger.log('ai-model.model.created', {
      id: record.id,
      providerId: record.providerId,
      modelKey: record.modelKey,
    })
    return this.toModelModel(record)
  }

  /** 更新模型：展示名 / 窗口 / 启停（启停是人的决定，同步不会覆盖它） */
  @Transactional()
  async updateModel(input: AiModelUpdateDto): Promise<AiModelModel> {
    const existing = await this.requireModel(input.modelId)
    const changes: DeepPartial<AiModelEntity> = {}
    if (input.displayName !== undefined) changes.displayName = input.displayName
    if (input.contextWindow !== undefined) changes.contextWindow = input.contextWindow
    if (input.maxOutputTokens !== undefined) changes.maxOutputTokens = input.maxOutputTokens
    if (input.enabled !== undefined) changes.enabled = input.enabled

    const record = await this.models.update(existing.id, changes)
    if (!record) throw new ModelNotFoundError(input.modelId)
    this.logger.log('ai-model.model.updated', {
      id: record.id,
      enabled: record.enabled,
      fields: Object.keys(changes),
    })
    return this.toModelModel(record)
  }

  /** 软删模型 */
  @Transactional()
  async removeModel(input: AiModelIdDto): Promise<void> {
    const existing = await this.requireModel(input.modelId)
    await this.models.softDelete(existing.id)
    this.logger.log('ai-model.model.removed', { id: existing.id, modelKey: existing.modelKey })
  }

  // ─────────────────────────── 运行时选模型（§4.9） ───────────────────────────

  /** 可选用模型清单：**只含"供应商启用 + 模型启用"的**（会话页选择器的数据源） */
  async listAvailable(): Promise<AiAvailableModelListModel> {
    const rows = await this.models.listEnabledWithProvider()
    const models = rows.map((row) => this.toAvailableModel(row.model, row.provider))
    return { models, defaultModelId: models[0]?.id ?? null }
  }

  /**
   * 解析"这一轮真正要用的模型"（**运行时唯一的模型来源**）。
   *
   * - 传了 `modelId` → 按 id 取；没有这个 id → 3402；存在但被禁用 → 3402 / 3404；
   * - 没传 → 取默认（第一个启用的：供应商创建时间升序 → `model_key` 升序）；
   * - **库空 → 3406**（`ModelNotConfiguredError`），绝不回落到环境变量；
   * - 供应商没配密钥 / 密钥解不开 → 3405，明确报错而不是把空串递给模型。
   */
  async resolveForRuntime(modelId?: string): Promise<ResolvedRuntimeModel> {
    const rows = await this.models.listEnabledWithProvider()
    if (rows.length === 0) throw new ModelNotConfiguredError()

    let resolved = rows[0]
    if (modelId) {
      const hit = rows.find((row) => row.model.id === modelId)
      if (hit) {
        resolved = hit
      } else {
        // 库里有可用模型，但这个 id 没在"启用清单"里：区分"根本没有 / 被禁用"
        const model = await this.models.findById(modelId)
        if (!model) throw new ModelNotFoundError(modelId)
        const provider = await this.providers.findById(model.providerId)
        if (!provider) throw new ModelNotFoundError(modelId)
        if (!provider.enabled) throw new ProviderDisabledError(provider.id)
        throw new ModelNotFoundError(modelId, `模型已禁用，不可用于本次对话：${modelId}`)
      }
    }

    const { model, provider } = resolved
    return {
      id: model.id,
      modelRef: `${provider.slug}/${model.modelKey}`,
      modelKey: model.modelKey,
      displayName: model.displayName,
      providerKind: provider.kind,
      ...(provider.baseUrl ? { baseURL: provider.baseUrl } : {}),
      apiKey: this.decryptProviderKey(provider),
      contextWindow: model.contextWindow,
    }
  }

  // ─────────────────────────────── 内部工具 ───────────────────────────────

  /** 对外供应商模型：**只有提示与"配没配"，没有明文**；`slug` 要回给页面（编辑 / 回显 / 拼 modelRef） */
  private toProviderModel(record: AiProviderEntity, modelCount: number): AiProviderViewModel {
    return {
      id: record.id,
      name: record.name,
      slug: record.slug,
      kind: record.kind,
      baseUrl: record.baseUrl,
      apiKeyHint: record.apiKeyHint,
      hasApiKey: Boolean(record.apiKeyCipher),
      enabled: record.enabled,
      lastSyncedAt: record.lastSyncedAt ?? undefined,
      lastSyncError: record.lastSyncError,
      metadata: record.metadata,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      // 契约（AiProviderSchema）暂未声明 modelCount，但列表页要用；多带一个字段不影响校验
      modelCount,
    }
  }

  private toModelModel(record: AiModelEntity): AiModelModel {
    return {
      id: record.id,
      providerId: record.providerId,
      modelKey: record.modelKey,
      displayName: record.displayName,
      contextWindow: record.contextWindow,
      maxOutputTokens: record.maxOutputTokens,
      capabilities: record.capabilities,
      source: record.source,
      enabled: record.enabled,
      lastSeenAt: record.lastSeenAt ?? undefined,
      syncedAt: record.syncedAt ?? undefined,
      raw: record.raw,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    }
  }

  private toAvailableModel(model: AiModelEntity, provider: AiProviderEntity): AiAvailableModelModel {
    return {
      id: model.id,
      modelRef: `${provider.slug}/${model.modelKey}`,
      modelKey: model.modelKey,
      displayName: model.displayName,
      providerId: provider.id,
      providerName: provider.name,
      providerKind: provider.kind,
      providerSlug: provider.slug,
      contextWindow: model.contextWindow,
      capabilities: model.capabilities,
    }
  }

  /** 取加密口令（未配置 → 3405） */
  private requireSecret(): string {
    return resolveEncryptionSecret({
      encryptionKey: this.config.encryptionKey,
      fallbackSecret: this.config.fallbackSecret,
    })
  }

  /** 解出供应商密钥明文（**只在内存里流转**；解不开 / 没配都明确抛 3405） */
  private decryptProviderKey(provider: AiProviderEntity): string {
    const cipher = provider.apiKeyCipher
    if (!cipher) {
      throw new ProviderKeyUnavailableError(
        `供应商「${provider.name}」未配置密钥，无法用于对话；请先在后台「模型管理」补上`,
      )
    }
    const secret = this.requireSecret()
    try {
      return decryptSecret(cipher, secret)
    } catch (error) {
      throw new ProviderKeyUnavailableError(
        `供应商「${provider.name}」密钥解密失败，请重新保存密钥：${messageOf(error)}`,
      )
    }
  }

  /** 名称唯一性检查（软删感知：软删的历史名可以复用，与库里的部分唯一索引同一口径） */
  private async assertNameAvailable(name: string, exceptId?: string): Promise<void> {
    const owner = await this.providers.findByName(name)
    if (owner && owner.id !== exceptId) {
      throw new ProviderNameTakenError(name, `供应商名称已存在：${name}`)
    }
  }

  /** slug 分配：base 为空报错；冲突则加 `-2`、`-3` … 重试（上限 20 次） */
  private async allocateSlug(base: string): Promise<string> {
    if (!base) throw new ProviderSlugInvalidError()
    if (!(await this.providers.findBySlug(base))) return base

    for (let attempt = 2; attempt <= SLUG_MAX_ATTEMPTS; attempt++) {
      const suffix = `-${attempt}`
      const candidate = `${base.slice(0, 32 - suffix.length)}${suffix}`
      if (!(await this.providers.findBySlug(candidate))) return candidate
    }
    throw new ProviderSlugInvalidError(
      `slug「${base}」已被占用太多（已试到 -${SLUG_MAX_ATTEMPTS}），请手动指定 slug`,
    )
  }

  private async requireProvider(providerId: string): Promise<AiProviderEntity> {
    const provider = await this.providers.findById(providerId)
    if (!provider) throw new ProviderNotFoundError(providerId)
    return provider
  }

  private async requireModel(modelId: string): Promise<AiModelEntity> {
    const model = await this.models.findById(modelId)
    if (!model) throw new ModelNotFoundError(modelId)
    return model
  }
}
