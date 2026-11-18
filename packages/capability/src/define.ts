import { z } from 'zod'
import {
  CapabilityDeclSchema,
  ServiceRegistrationSchema,
  type CapabilityDecl,
  type CapabilityExecution,
  ServiceInstanceSchema,
  type ServiceRegistration,
} from '@repo/contracts'

/**
 * 能力与服务定义的**类型与转换**（内部服务用）。
 *
 * 三条口径：
 * - **定义与实现写在同一个服务里**，pkg 只提供机制与类型，不放具体能力；
 * - 能力不写在这里，写 `@CapabilityDecl`（见 `decorator.ts`）—— 本文件只留类型与转换；
 * - 入参用 zod 写，登记前一次性转成 JSON Schema（模型看到的就是它）。
 */
export interface CapabilityDefinition {
  /** 工具名，服务内唯一（服务是「一组工具」的登记单位） */
  tool: string
  title: string
  /** 给模型看：什么时候用、什么时候不用、约束 */
  description: string
  /** zod 入参；`.describe()` 会变成字段说明 */
  input: z.ZodType
  risk?: 'read' | 'write'
  idempotent?: boolean
  scope?: 'all' | 'user' | 'admin' | 'agent'
  allowedAgents?: string[]
  timeoutMs?: number
  pagination?: 'none' | 'cursor'
  tags?: string[]
  execution?: Partial<CapabilityExecution>
  /** false = 声明了但不上报（`plan/*`、`agent/*` 这类编排原语） */
  register?: boolean
}

export interface ServiceDefinition {
  /** 服务名（全局唯一；一个进程 = 一个服务） */
  service: string
  title: string
  description?: string
  owner: string
  capabilities: CapabilityDefinition[]
}

/** zod → JSON Schema（draft 2020-12）；`.describe()` 直接变成 `description` */
export const toInputSchema = (schema: z.ZodType): Record<string, unknown> => {
  const converted = z.toJSONSchema(schema) as Record<string, unknown>
  return converted
}

const toDecl = (definition: CapabilityDefinition): CapabilityDecl =>
  CapabilityDeclSchema.parse({
    tool: definition.tool,
    title: definition.title,
    description: definition.description,
    inputSchema: toInputSchema(definition.input),
    risk: definition.risk ?? 'read',
    idempotent: definition.idempotent ?? false,
    scope: definition.scope ?? 'all',
    ...(definition.allowedAgents === undefined ? {} : { allowedAgents: definition.allowedAgents }),
    timeoutMs: definition.timeoutMs ?? 30_000,
    pagination: definition.pagination ?? 'none',
    tags: definition.tags ?? [],
    ...(definition.execution === undefined ? {} : { execution: definition.execution }),
  })

export interface RegistrationOptions {
  /** 内部服务：本实例信息；外部服务不传（改传 baseUrl） */
  instance?: z.input<typeof ServiceInstanceSchema>
  /** 外部服务：网关调用地址 */
  baseUrl?: string
  source?: 'code' | 'manual'
  healthPath?: string
  /** 外部服务的原生协议；内部服务只说能力协议（默认 capability） */
  protocol?: 'capability' | 'mcp'
}

/** 服务定义 → 上报给网关的登记体（key 就是工具名，由网关建索引） */
export const toRegistration = (
  service: ServiceDefinition,
  options: RegistrationOptions = {},
): ServiceRegistration =>
  ServiceRegistrationSchema.parse({
    protocolVersion: 1,
    service: service.service,
    title: service.title,
    owner: service.owner,
    source: options.source ?? 'code',
    protocol: options.protocol ?? 'capability',
    ...(service.description === undefined ? {} : { description: service.description }),
    ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
    ...(options.healthPath === undefined ? {} : { healthPath: options.healthPath }),
    ...(options.instance === undefined ? {} : { instance: options.instance }),
    capabilities: service.capabilities
      .filter((definition) => definition.register !== false)
      .map(toDecl),
  })
