import { z } from 'zod'
import {
  ToolInvokeResponseSchema,
  ToolListResponseSchema,
  WorkerRegistrationSchema,
  type ToolInvokeRequest,
  type ToolInvokeResponse,
  type ToolListRequest,
  type ToolListResponse,
  type WorkerRegistration,
} from '@repo/contracts'
import {
  requestEnvelope,
  requestJson,
  type InternalClientOptions,
  type InvokeOptions,
} from './http.js'

const WorkersResponseSchema = z.object({
  workers: z.array(WorkerRegistrationSchema),
})

const HealthResponseSchema = z.object({ status: z.string() })

/**
 * tool-gateway 的客户端。
 *
 * facade / 编排层只认这个类，不认 HTTP：换 host、加 token、改超时都在 SDK 里。
 */
export class ToolGatewayClient {
  constructor(private readonly options: InternalClientOptions) {}

  invokeTool(request: ToolInvokeRequest, options: InvokeOptions = {}): Promise<ToolInvokeResponse> {
    return requestEnvelope(this.options, '/v1/tools/invoke', ToolInvokeResponseSchema, {
      method: 'POST',
      body: request,
      ...options,
    })
  }

  /** 工具面：facade / 模型从这里拿可用工具清单 */
  listTools(request: ToolListRequest, options: InvokeOptions = {}): Promise<ToolListResponse> {
    return requestEnvelope(this.options, '/v1/tools/list', ToolListResponseSchema, {
      method: 'POST',
      body: request,
      ...options,
    })
  }

  async listWorkers(options: InvokeOptions = {}): Promise<WorkerRegistration[]> {
    const response = await requestEnvelope(
      this.options,
      '/v1/workers',
      WorkersResponseSchema,
      options,
    )
    return response.workers
  }

  health(options: InvokeOptions = {}): Promise<{ status: string }> {
    return requestJson(this.options, '/healthz', HealthResponseSchema, options)
  }
}
