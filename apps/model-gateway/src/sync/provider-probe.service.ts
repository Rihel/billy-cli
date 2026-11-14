import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common'
import type {
  ProviderListModelsRequest,
  ProviderListModelsResponse,
  ProviderProbeResponse,
} from '@repo/contracts'
import { AiProviderEntity } from '@repo/db'
import { Db } from '@repo/kits'
import { listProviderModels } from './provider-adapters.js'
import { ProviderProbeFailedError } from './probe.errors.js'

/** 解析后的供应商配置（探针用；key 只在内存） */
interface ProbeConfig {
  kind: string
  baseUrl: string | null
  apiKey: string | null
}

/**
 * 供应商探测：列模型 / 连通性测试。
 *
 * 从 main 迁入网关：**与供应商的交互（含明文 key）只在网关发生**，
 * main 只负责把结果 upsert 进库 / 返回给页面。
 */
@Injectable()
export class ProviderProbeService {
  constructor(@Inject(Db) private readonly db: Db) {}

  async listModels(input: ProviderListModelsRequest): Promise<ProviderListModelsResponse> {
    const config = await this.resolve(input)
    if (!config.apiKey?.trim()) {
      throw new ProviderProbeFailedError(
        '该供应商未配置密钥，无法拉取模型明细；请先在「编辑供应商」里填入 API Key',
      )
    }
    const listing = await listProviderModels({
      kind: config.kind,
      baseUrl: config.baseUrl,
      apiKey: config.apiKey ?? '',
    })
    return {
      models: listing.models as ProviderListModelsResponse['models'],
      endpoint: listing.endpoint,
    }
  }

  async test(input: ProviderListModelsRequest): Promise<ProviderProbeResponse> {
    const startedAt = Date.now()
    try {
      const listing = await this.listModels(input)
      return {
        ok: true,
        modelCount: listing.models.length,
        error: null,
        endpoint: listing.endpoint,
        durationMs: Date.now() - startedAt,
      }
    } catch (error) {
      return {
        ok: false,
        modelCount: 0,
        error: messageOf(error),
        endpoint: error instanceof ProviderProbeFailedError ? error.endpoint : '',
        durationMs: Date.now() - startedAt,
      }
    }
  }

  private async resolve(input: ProviderListModelsRequest): Promise<ProbeConfig> {
    if (input.providerId) {
      const provider = await this.db
        .getRepository(AiProviderEntity)
        .findOne({ where: { id: input.providerId } })
      if (!provider) throw new NotFoundException(`供应商不存在：${input.providerId}`)
      return {
        kind: input.kind ?? provider.kind,
        baseUrl: provider.baseUrl ?? null,
        apiKey: provider.apiKey ?? input.apiKey?.trim() ?? null,
      }
    }
    if (!input.kind) throw new BadRequestException('缺少 kind（未保存先测时必须传）')
    return {
      kind: input.kind,
      baseUrl: input.baseUrl ?? null,
      apiKey: input.apiKey?.trim() || null,
    }
  }
}

const messageOf = (error: unknown): string => {
  if (error instanceof Error) return error.message
  return String(error)
}
