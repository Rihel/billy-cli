import { Inject, Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import type { GatewayModelEntry } from '@repo/contracts'
import { AppError } from '@repo/kits'
import { ModelGatewayClient } from '@repo/internal-sdk'
import { AppErrorCodes } from '@repo/shared'
import type { RuntimeModel } from '../../foundation/envelope.js'
import type { ModelAttribution, RuntimeModelResolver } from './model-resolver.js'

interface ModelGatewaySettings {
  url: string
  token: string
  timeoutMs: number
}

/** 网关目录为空：等价于旧的 3406（没配可用模型） */
class GatewayModelUnavailableError extends AppError {
  readonly code = AppErrorCodes.ModelNotConfigured
  constructor() {
    super('还没有配置可用的模型，请先在后台「模型管理」添加')
  }
}

/** 指定的模型 id 不在网关目录里 */
class GatewayModelNotFoundError extends AppError {
  readonly code = AppErrorCodes.ModelNotFound
  constructor(modelId: string) {
    super(`模型不存在或未启用：${modelId}`)
  }
}

/**
 * runtime 侧的网关目录客户端（生产唯一模型来源）。
 *
 * 只做两件事：拿目录（缓存 30s）、把目录条目转成 `RuntimeModel`。
 * **不持有供应商 key / 上游地址**——这两样只存在于网关进程。
 *
 * 生产唯一模型来源：runtime 的 `modules/ai-model/**` 已删除，不再有进程内直连回退。
 */
@Injectable()
export class ModelGatewayCatalogService implements RuntimeModelResolver {
  private readonly client: ModelGatewayClient
  private readonly settings: ModelGatewaySettings
  private cache: { at: number; models: GatewayModelEntry[]; defaultModelId: string | null } | null =
    null
  private pending: Promise<{
    models: GatewayModelEntry[]
    defaultModelId: string | null
  }> | null = null

  constructor(@Inject(ConfigService) config: ConfigService) {
    this.settings = config.getOrThrow<ModelGatewaySettings>('modelGateway')
    this.client = new ModelGatewayClient({
      baseUrl: this.settings.url,
      token: this.settings.token,
      timeoutMs: this.settings.timeoutMs,
    })
  }

  /** 目录（进程内缓存；配置变更靠网关侧 TTL / 事件，双方都只读） */
  async catalog(): Promise<{ models: GatewayModelEntry[]; defaultModelId: string | null }> {
    if (this.cache && Date.now() - this.cache.at < 30_000) {
      return { models: this.cache.models, defaultModelId: this.cache.defaultModelId }
    }
    this.pending ??= this.client
      .catalog()
      .then((result) => {
        this.cache = {
          at: Date.now(),
          models: result.models,
          defaultModelId: result.defaultModelId,
        }
        return result
      })
      .finally(() => {
        this.pending = null
      })
    return this.pending
  }

  /** 解析这一轮要用的模型（省略 id 取默认）；返回可直接交给 Mastra 的运行时模型 */
  async resolveForRuntime(modelId?: string, attribution?: ModelAttribution): Promise<RuntimeModel> {
    const catalog = await this.catalog()
    const id = modelId ?? catalog.defaultModelId
    if (!id) throw new GatewayModelUnavailableError()
    const entry = catalog.models.find((item) => item.id === id)
    if (!entry) throw new GatewayModelNotFoundError(id)
    return toRuntimeModel(entry, this.settings, attribution)
  }

  /** 可用模型清单（能力状态 / 选择器用；不含 key） */
  async listAvailable(): Promise<{
    models: Array<{ id: string; modelRef: string }>
    defaultModelId: string | null
  }> {
    const catalog = await this.catalog()
    return {
      models: catalog.models.map((item) => ({ id: item.id, modelRef: item.modelRef })),
      defaultModelId: catalog.defaultModelId,
    }
  }
}

const toRuntimeModel = (
  entry: GatewayModelEntry,
  settings: ModelGatewaySettings,
  attribution?: ModelAttribution,
): RuntimeModel => ({
  id: entry.id,
  modelRef: entry.modelRef,
  modelKey: entry.modelKey,
  displayName: entry.displayName,
  providerKind: entry.providerKind,
  // 供应商密钥不进 runtime；apiKey 留空由 Mastra 适配器忽略（网关侧注入真实 key）
  apiKey: '',
  contextWindow: entry.contextWindow,
  inputModalities: entry.inputModalities,
  gateway: {
    url: settings.url.replace(/\/+$/, ''),
    token: settings.token,
    modelId: entry.id,
    headers: attributionHeaders(attribution),
  },
})

/** 归因头：网关据此把用量记到 run / 会话 / 身份（缺省就不带，不报错） */
const attributionHeaders = (attribution?: ModelAttribution): Record<string, string> => {
  const headers: Record<string, string> = {}
  if (attribution?.runId) headers['x-billy-run-id'] = attribution.runId
  if (attribution?.conversationId) headers['x-billy-conversation-id'] = attribution.conversationId
  if (attribution?.identityType) headers['x-billy-identity-type'] = attribution.identityType
  if (attribution?.identityId) headers['x-billy-identity-id'] = attribution.identityId
  return headers
}
