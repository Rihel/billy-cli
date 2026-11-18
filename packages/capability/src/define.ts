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
 * 能力定义的写法（内部服务用）。
 *
 * 三条口径：
 * - **定义与实现写在同一个服务里**，pkg 只提供这套工具函数，不放具体能力；
 * - 入参用 zod 写，注册前一次性转成 JSON Schema（模型看到的就是它）；
 * - `register: false` 的能力会被声明但不上报（编排原语用）。
 */
export interface CapabilityDefinition {
  /** 工具名，服务内唯一（服务名由 `defineService` 给） */
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

export const defineCapability = (definition: CapabilityDefinition): CapabilityDefinition =>
  definition

export interface ServiceDefinition {
  /** 服务名（namespace），全局唯一 */
  service: string
  title: string
  description?: string
  owner: string
  capabilities: CapabilityDefinition[]
}

export const defineService = (definition: ServiceDefinition): ServiceDefinition => definition

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
}

/** 服务定义 → 上报给网关的登记体（key 由网关拼，这里不拼） */
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
    ...(service.description === undefined ? {} : { description: service.description }),
    ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
    ...(options.healthPath === undefined ? {} : { healthPath: options.healthPath }),
    ...(options.instance === undefined ? {} : { instance: options.instance }),
    capabilities: service.capabilities
      .filter((definition) => definition.register !== false)
      .map(toDecl),
  })
