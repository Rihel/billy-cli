import { z } from 'zod'
import {
  ToolInvokeResponseSchema,
  type ToolInvokeRequest,
  type ToolInvokeResponse,
} from '@repo/contracts'
import {
  requestEnvelope,
  requestJson,
  type InternalClientOptions,
  type InvokeOptions,
} from './http.js'

const HealthResponseSchema = z.object({
  status: z.string(),
  workerId: z.string().optional(),
})

/**
 * tool-worker 的客户端。
 *
 * 只给 tool-gateway 用；worker 是内部数据面，不暴露给公网。
 */
export class ToolWorkerClient {
  constructor(private readonly options: InternalClientOptions) {}

  exec(request: ToolInvokeRequest, options: InvokeOptions = {}): Promise<ToolInvokeResponse> {
    return requestEnvelope(this.options, '/v1/exec', ToolInvokeResponseSchema, {
      method: 'POST',
      body: request,
      ...options,
    })
  }

  health(options: InvokeOptions = {}): Promise<{ status: string; workerId?: string }> {
    return requestJson(this.options, '/healthz', HealthResponseSchema, options)
  }
}
