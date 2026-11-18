import { z } from 'zod'
import {
  CapabilityInvokeResultSchema,
  CapabilityListResponseSchema,
  CapabilityTaskSnapshotSchema,
  RegisteredServiceSchema,
  ServiceRegisterResultSchema,
  type CapabilityInvokeRequest,
  type CapabilityInvokeResult,
  type CapabilityListRequest,
  type CapabilityListResponse,
  type CapabilityServiceStatus,
  type CapabilityTaskQuery,
  type CapabilityTaskSnapshot,
  type RegisteredService,
  type ServiceRegistration,
  type ServiceRegisterResult,
} from '@repo/contracts'
import { requestEnvelope, type InternalClientOptions, type InvokeOptions } from './http.js'

const ServiceListResponseSchema = z.object({ services: z.array(RegisteredServiceSchema) })

/**
 * 能力网关的客户端（给 main 的后台、runtime 的上游用）。
 *
 * 规矩和别的内部客户端一样：只走 typed client，业务代码不自己拼地址与令牌。
 */
export class CapabilityGatewayClient {
  constructor(private readonly options: InternalClientOptions) {}

  register(
    registration: ServiceRegistration,
    options: InvokeOptions = {},
  ): Promise<ServiceRegisterResult> {
    return requestEnvelope(this.options, '/v1/services/register', ServiceRegisterResultSchema, {
      method: 'POST',
      body: registration,
      ...options,
    })
  }

  deregisterService(service: string, options: InvokeOptions = {}): Promise<{ removed: boolean }> {
    return requestEnvelope(
      this.options,
      '/v1/services/deregister',
      z.object({ removed: z.boolean() }),
      { method: 'POST', body: { service }, ...options },
    )
  }

  setStatus(
    status: CapabilityServiceStatus,
    options: InvokeOptions = {},
  ): Promise<{ updated: boolean }> {
    return requestEnvelope(
      this.options,
      '/v1/services/status',
      z.object({ updated: z.boolean() }),
      { method: 'POST', body: status, ...options },
    )
  }

  listServices(options: InvokeOptions = {}): Promise<{ services: RegisteredService[] }> {
    return requestEnvelope(this.options, '/v1/services/list', ServiceListResponseSchema, {
      method: 'POST',
      body: {},
      ...options,
    })
  }

  listCapabilities(
    request: CapabilityListRequest,
    options: InvokeOptions = {},
  ): Promise<CapabilityListResponse> {
    return requestEnvelope(this.options, '/v1/capabilities/list', CapabilityListResponseSchema, {
      method: 'POST',
      body: request,
      ...options,
    })
  }

  invoke(
    request: CapabilityInvokeRequest,
    options: InvokeOptions = {},
  ): Promise<CapabilityInvokeResult> {
    return requestEnvelope(this.options, '/v1/capabilities/invoke', CapabilityInvokeResultSchema, {
      method: 'POST',
      body: request,
      ...options,
    })
  }

  getTask(
    query: CapabilityTaskQuery,
    options: InvokeOptions = {},
  ): Promise<CapabilityTaskSnapshot> {
    return requestEnvelope(this.options, '/v1/tasks/get', CapabilityTaskSnapshotSchema, {
      method: 'POST',
      body: query,
      ...options,
    })
  }

  cancelTask(taskId: string, options: InvokeOptions = {}): Promise<CapabilityTaskSnapshot> {
    return requestEnvelope(this.options, '/v1/tasks/cancel', CapabilityTaskSnapshotSchema, {
      method: 'POST',
      body: { taskId },
      ...options,
    })
  }
}
