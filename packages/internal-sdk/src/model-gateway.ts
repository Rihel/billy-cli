import { z } from 'zod'
import {
  GatewayCatalogSchema,
  ProviderListModelsResponseSchema,
  ProviderProbeResponseSchema,
  type GatewayCatalog,
  type ProviderListModelsRequest,
  type ProviderListModelsResponse,
  type ProviderProbeRequest,
  type ProviderProbeResponse,
} from '@repo/contracts'
import {
  requestEnvelope,
  requestJson,
  type InternalClientOptions,
  type InvokeOptions,
} from './http.js'

/**
 * model-gateway 的客户端（runtime → 网关）。
 *
 * 只封装目录查询；对话是**流式响应**，由 runtime 的 HTTP 客户端直接对流处理
 * （`/v1/models/{modelId}/chat/completions`），不经过 requestJson。
 */
export class ModelGatewayClient {
  constructor(private readonly options: InternalClientOptions) {}

  /** 模型目录（不含密钥 / 上游地址；runtime 用它做运行期解析） */
  catalog(options: InvokeOptions = {}): Promise<GatewayCatalog> {
    return requestEnvelope(this.options, '/internal/catalog', GatewayCatalogSchema, options)
  }

  /** 列模型（同步用）：供应商交互在网关，main 只拿解析后的明细 */
  listProviderModels(
    input: ProviderListModelsRequest,
    options: InvokeOptions = {},
  ): Promise<ProviderListModelsResponse> {
    return requestEnvelope(
      this.options,
      '/internal/providers/list-models',
      ProviderListModelsResponseSchema,
      {
        method: 'POST',
        body: input,
        ...options,
      },
    )
  }

  /** 连通性测试（未保存先测也行） */
  testProvider(
    input: ProviderProbeRequest,
    options: InvokeOptions = {},
  ): Promise<ProviderProbeResponse> {
    return requestEnvelope(this.options, '/internal/providers/test', ProviderProbeResponseSchema, {
      method: 'POST',
      body: input,
      ...options,
    })
  }

  health(options: InvokeOptions = {}): Promise<{ status: string }> {
    return requestJson(this.options, '/healthz', GatewayReadyLiteSchema, options)
  }
}

const GatewayReadyLiteSchema = z.object({ status: z.string() })
