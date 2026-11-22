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
  type McpDiscover,
  type McpDiscoverResult,
  type CapabilityServiceStatus,
  type CapabilityTaskQuery,
  type CapabilityTaskSnapshot,
  type RegisteredService,
  McpDiscoverResultSchema,
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

  /** 实例心跳：只刷 `active`；返回 `known=false` 时服务侧应重发 register */
  heartbeat(
    service: string,
    instanceId: string,
    active: number,
    options: InvokeOptions = {},
  ): Promise<{ known: boolean }> {
    return requestEnvelope(
      this.options,
      '/v1/instances/heartbeat',
      z.object({ known: z.boolean() }),
      { method: 'POST', body: { service, instanceId, active }, ...options },
    )
  }

  /** 实例摘除（优雅停机）：只摘流量，服务记录与能力保留 */
  deregisterInstance(
    service: string,
    instanceId: string,
    options: InvokeOptions = {},
  ): Promise<{ removed: boolean }> {
    return requestEnvelope(
      this.options,
      '/v1/instances/deregister',
      z.object({ removed: z.boolean() }),
      { method: 'POST', body: { service, instanceId }, ...options },
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

  /** 发现一个 MCP server 的工具（后台同步能力清单用；不落库） */
  discoverMcp(input: McpDiscover, options: InvokeOptions = {}): Promise<McpDiscoverResult> {
    return requestEnvelope(this.options, '/v1/services/mcp/list', McpDiscoverResultSchema, {
      method: 'POST',
      body: input,
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

  /** 停止一轮对话：取消本轮发起的 session 任务（服务侧自己的任务不随对话取消） */
  cancelRunTasks(
    runId: string,
    options: InvokeOptions = {},
  ): Promise<{ targets: number; canceled: number; degraded?: boolean }> {
    return requestEnvelope(
      this.options,
      '/v1/tasks/cancel-run',
      z.object({ targets: z.number(), canceled: z.number() }),
      { method: 'POST', body: { runId }, ...options },
    )
  }

  cancelTask(taskId: string, options: InvokeOptions = {}): Promise<CapabilityTaskSnapshot> {
    return requestEnvelope(this.options, '/v1/tasks/cancel', CapabilityTaskSnapshotSchema, {
      method: 'POST',
      body: { taskId },
      ...options,
    })
  }
}
