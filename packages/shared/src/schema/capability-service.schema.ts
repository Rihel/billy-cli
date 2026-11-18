import { z } from 'zod'

/**
 * 能力服务（后台登记外部服务）的接口契约。
 *
 * 页面只管「填什么」；真正的校验与路由在网关，这里做入参形状与错误提示。
 */
export const CapabilityServiceNameField = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,23}$/, '只能是小写字母、数字与连字符，最多 24 位')

export const CapabilityServiceCapabilitySchema = z.object({
  tool: z
    .string()
    .regex(/^(?!.*__)[a-z0-9][a-z0-9-]{0,31}$/, '只能是小写字母、数字与连字符，最多 32 位'),
  title: z.string().min(1).max(64),
  description: z.string().min(1).max(900),
  inputSchema: z.record(z.string(), z.unknown()).default({ type: 'object' }),
  risk: z.enum(['read', 'write']).default('read'),
})

export type CapabilityServiceCapabilityDto = z.infer<typeof CapabilityServiceCapabilitySchema>

export const CapabilityServiceListSchema = z.object({
  keyword: z.string().max(64).optional(),
})

export type CapabilityServiceListDto = z.infer<typeof CapabilityServiceListSchema>

export const CapabilityServiceSaveSchema = z.object({
  service: CapabilityServiceNameField,
  title: z.string().min(1).max(64),
  description: z.string().max(500).optional(),
  owner: z.string().min(1).max(128),
  baseUrl: z.string().url(),
  healthPath: z.string().min(1).max(128).default('/healthz'),
  allowHttp: z.boolean().default(false),
  auth: z
    .object({
      mode: z.enum(['none', 'service-token', 'gateway-injected']).default('gateway-injected'),
      header: z.string().min(1).max(64).default('authorization'),
      /** 留空 = 不改；新建时留空 = 无凭据 */
      credential: z.string().max(4_096).optional(),
    })
    .default({ mode: 'gateway-injected', header: 'authorization' }),
  capabilities: z.array(CapabilityServiceCapabilitySchema).min(1),
})

export type CapabilityServiceSaveDto = z.infer<typeof CapabilityServiceSaveSchema>

export const CapabilityServiceIdSchema = z.object({
  service: CapabilityServiceNameField,
})

export type CapabilityServiceIdDto = z.infer<typeof CapabilityServiceIdSchema>

export const CapabilityServiceStatusSchema = z.object({
  service: CapabilityServiceNameField,
  status: z.enum(['draft', 'active', 'disabled']),
})

export type CapabilityServiceStatusDto = z.infer<typeof CapabilityServiceStatusSchema>

export const CapabilityServiceTestSchema = z.object({
  service: CapabilityServiceNameField.optional(),
  baseUrl: z.string().url(),
  healthPath: z.string().min(1).max(128).default('/healthz'),
})

export type CapabilityServiceTestDto = z.infer<typeof CapabilityServiceTestSchema>

export const CapabilityServiceTestResultSchema = z.object({
  ok: z.boolean(),
  status: z.number().int().optional(),
  message: z.string().optional(),
})

export type CapabilityServiceTestResultDto = z.infer<typeof CapabilityServiceTestResultSchema>

/** 后台看到的一条服务（**不含凭据**，只有 `hasCredential`） */
export const CapabilityServiceModelSchema = z.object({
  service: z.string(),
  title: z.string(),
  description: z.string().optional(),
  owner: z.string(),
  source: z.enum(['code', 'manual']),
  baseUrl: z.string().optional(),
  healthPath: z.string(),
  status: z.enum(['draft', 'active', 'disabled']),
  allowHttp: z.boolean(),
  version: z.number().int(),
  updatedAt: z.number().int(),
  capabilities: z.array(
    z.object({
      tool: z.string(),
      title: z.string(),
      description: z.string(),
      risk: z.enum(['read', 'write']),
    }),
  ),
  instances: z
    .array(z.object({ instanceId: z.string(), active: z.number(), maxConcurrency: z.number() }))
    .optional(),
  hasCredential: z.boolean().default(false),
  probe: z
    .object({ state: z.enum(['unknown', 'up', 'down']), lastProbedAt: z.number() })
    .optional(),
})

export type CapabilityServiceModel = z.infer<typeof CapabilityServiceModelSchema>
