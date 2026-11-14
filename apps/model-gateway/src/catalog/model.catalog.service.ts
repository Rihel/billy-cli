import { Inject, Injectable, NotFoundException } from '@nestjs/common'
import type { GatewayCatalog, GatewayModelEntry } from '@repo/contracts'
import { AiModelEntity, AiProviderEntity } from '@repo/db'
import { Db } from '@repo/kits'
import { CHAT_CAPABLE_MODES, normalizeModelMode, protocolOfKind } from '@repo/shared'
import { ModelGatewayConfig, type ModelGatewayConfigValue } from '../config/app-config.js'
import type { PriceRates } from '../usage/usage.js'

/** 一次对话需要的最小上下文：目录条目 + 上游凭据/地址（**只在网关进程内**） */
export interface GatewayTarget {
  entry: GatewayModelEntry
  /** 供应商密钥（明文，来自 `ai_providers.api_key`；Ollama 可为 null） */
  apiKey: string | null
  /** 供应商地址（null = 用 kind 的默认画像） */
  baseUrl: string | null
  /** 模型价格（算成本用；null = 未配置） */
  prices: PriceRates | null
}

interface CatalogState {
  at: number
  catalog: GatewayCatalog
  targets: Map<string, GatewayTarget>
}

/**
 * 模型目录（**运行时唯一读配置表的地方**）。
 *
 * - 只选「供应商启用 + 模型启用 + 对话类」的模型；
 * - `defaultModelId` = 第一条（供应商创建时间升序 → `model_key` 升序，与 main 的选项一致）；
 * - 结果按 `cacheTtlMs` 缓存（配置变更后续由 `ai.model.changed` 事件失效，P4.2b）。
 */
@Injectable()
export class ModelCatalogService {
  private cache: CatalogState | null = null

  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(ModelGatewayConfig) private readonly config: ModelGatewayConfigValue,
  ) {}

  /** 配置变更事件：清缓存（下一次请求重新读库） */
  invalidate(): void {
    this.cache = null
  }

  async catalog(): Promise<GatewayCatalog> {
    return (await this.load()).catalog
  }

  async count(): Promise<number> {
    return (await this.catalog()).models.length
  }

  /** 按 id 解析（省略取默认）；不存在或未启用抛 404 */
  async resolve(modelId?: string): Promise<GatewayTarget> {
    const state = await this.load()
    const id = modelId ?? state.catalog.defaultModelId
    if (!id) {
      throw new NotFoundException('还没有配置可用的对话模型，请先在后台「模型管理」添加')
    }
    const hit = state.targets.get(id)
    if (!hit) throw new NotFoundException(`模型不存在或未启用：${id}`)
    return hit
  }

  private async load(): Promise<CatalogState> {
    if (this.cache && Date.now() - this.cache.at < this.config.cacheTtlMs) return this.cache
    const [providers, models] = await Promise.all([
      this.db.getRepository(AiProviderEntity).find({
        where: { enabled: true },
        order: { createdAt: 'ASC' },
      }),
      this.db.getRepository(AiModelEntity).find({
        where: { enabled: true },
        order: { modelKey: 'ASC' },
      }),
    ])
    const state = buildCatalog(providers, models)
    this.cache = { at: Date.now(), ...state }
    return this.cache
  }
}

/**
 * 纯函数：实体行 → 目录（可单测，不碰 DB）。
 *
 * 过滤口径与 main 的 `listAvailable` **同一份**（chat / completion / unknown），
 * 否则「后台能选、运行时说没有」会打架。
 */
export const buildCatalog = (
  providers: readonly AiProviderEntity[],
  models: readonly AiModelEntity[],
): { catalog: GatewayCatalog; targets: Map<string, GatewayTarget> } => {
  const providerById = new Map(providers.map((item) => [item.id, item]))
  // 默认顺序：供应商创建时间（入参顺序）→ modelKey；显式排序让纯函数不依赖调用方的 order
  const providerRank = new Map(providers.map((item, index) => [item.id, index]))
  const ordered = [...models].sort((left, right) => {
    const rank =
      (providerRank.get(left.providerId) ?? 0) - (providerRank.get(right.providerId) ?? 0)
    return rank !== 0 ? rank : left.modelKey.localeCompare(right.modelKey)
  })
  const entries: GatewayModelEntry[] = []
  const targets = new Map<string, GatewayTarget>()

  for (const model of ordered) {
    const provider = providerById.get(model.providerId)
    if (!provider) continue
    const mode = normalizeModelMode(model.mode)
    if (!(mode === 'unknown' || CHAT_CAPABLE_MODES.includes(mode))) continue

    const entry: GatewayModelEntry = {
      id: model.id,
      modelRef: `${provider.slug}/${model.modelKey}`,
      modelKey: model.modelKey,
      displayName: model.displayName,
      providerId: provider.id,
      providerName: provider.name,
      providerSlug: provider.slug,
      providerKind: provider.kind,
      protocol: protocolOfKind(provider.kind) as GatewayModelEntry['protocol'],
      contextWindow: model.contextWindow,
      mode,
      inputModalities: model.inputModalities,
      outputModalities: model.outputModalities,
    }
    entries.push(entry)
    const priceConfigured =
      model.inputPricePer1m !== null ||
      model.outputPricePer1m !== null ||
      model.cacheReadPricePer1m !== null ||
      model.cacheWritePricePer1m !== null
    targets.set(entry.id, {
      entry,
      apiKey: provider.apiKey,
      baseUrl: provider.baseUrl,
      prices: priceConfigured
        ? {
            currency: model.currency,
            inputPer1m: model.inputPricePer1m,
            outputPer1m: model.outputPricePer1m,
            cacheReadPer1m: model.cacheReadPricePer1m,
            cacheWritePer1m: model.cacheWritePricePer1m,
            perImage: model.pricePerImage,
            perSecond: model.pricePerSecond,
          }
        : null,
    })
  }

  return {
    catalog: { models: entries, defaultModelId: entries[0]?.id ?? null },
    targets,
  }
}
