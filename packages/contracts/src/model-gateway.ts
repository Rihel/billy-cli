import { z } from 'zod'

/**
 * model-gateway 内部契约（版本 1）。
 *
 * 约定：
 * - 网关的**业务响应不套信封**（与 capability-gateway 一致），直接回 JSON；
 * - 对外对话接口是 **OpenAI Chat Completions 形态**（runtime 用 AI SDK 的 openai-compatible 解析）；
 * - 这里只定义「网关 ↔ 内部调用方」的结构，不定义各供应商的私有协议。
 */
export const MODEL_GATEWAY_CONTRACT_VERSION = 1 as const

/** 网关支持的线路协议（与 `AiProviderProtocol` 字典同值） */
export const GatewayProtocolSchema = z.enum([
  'openai-compatible',
  'deepseek',
  'anthropic',
  'ollama',
])

export type GatewayProtocol = z.infer<typeof GatewayProtocolSchema>

/** 一个可对话模型（**不含任何密钥 / 上游地址**） */
export const GatewayModelEntrySchema = z.object({
  /** `ai_models.id`（运行时按它路由：`/v1/models/{id}/chat/completions`） */
  id: z.string(),
  /** `<providerSlug>/<modelKey>`（展示 / 日志用） */
  modelRef: z.string(),
  /** 供应商侧的模型 id（请求体里的 `model`） */
  modelKey: z.string(),
  displayName: z.string(),
  providerId: z.string(),
  providerName: z.string(),
  providerSlug: z.string(),
  /** `ai_providers.kind`（厂商） */
  providerKind: z.string(),
  /** 线路协议（决定网关用哪个适配器） */
  protocol: GatewayProtocolSchema,
  /** 上下文窗口（null = 未配置） */
  contextWindow: z.number().int().positive().nullable(),
  /** 模型类型（chat / completion / embedding …） */
  mode: z.string(),
  /** 输入模态（null = 未声明） */
  inputModalities: z.array(z.string()).nullable(),
  /** 输出模态（null = 未声明） */
  outputModalities: z.array(z.string()).nullable(),
})

export type GatewayModelEntry = z.infer<typeof GatewayModelEntrySchema>

/** 模型目录（runtime 用它做运行期解析与能力判断） */
export const GatewayCatalogSchema = z.object({
  models: z.array(GatewayModelEntrySchema),
  /** 默认模型 id（无可用模型时为 null） */
  defaultModelId: z.string().nullable(),
})

export type GatewayCatalog = z.infer<typeof GatewayCatalogSchema>

/**
 * 对话请求体的**最小校验**：其余字段原样透传给上游。
 *
 * 注意：`model` 只用于日志 / 兜底；真正路由用路径里的 modelId，
 * 上游请求体里的 `model` 会被网关替换成供应商的 `modelKey`（见 chat 服务）。
 */
export const GatewayChatBodySchema = z
  .object({
    model: z.string().min(1).optional(),
    messages: z.array(z.record(z.string(), z.unknown())).min(1),
    stream: z.boolean().optional(),
  })
  .passthrough()

export type GatewayChatBody = z.infer<typeof GatewayChatBodySchema>

/** 一次调用的用量（网关旁路解析后记账用；字段可空，不编造 0） */
export const GatewayUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  totalTokens: z.number().int().nonnegative().nullable(),
  cacheReadTokens: z.number().int().nonnegative().nullable(),
  cacheWriteTokens: z.number().int().nonnegative().nullable(),
  reasoningTokens: z.number().int().nonnegative().nullable(),
})

export type GatewayUsage = z.infer<typeof GatewayUsageSchema>

/** 健康检查（readyz 只探 PG，不探供应商） */
export const GatewayReadySchema = z.object({
  status: z.enum(['ok', 'degraded']),
  db: z.boolean(),
  models: z.number().int().nonnegative(),
})

export type GatewayReady = z.infer<typeof GatewayReadySchema>

// ─────────────────────── 供应商探测（列模型 / 连通性测试） ───────────────────────

/** 供应商侧解析后的模型（同步用；`raw` 原样进 ai_models.raw） */
export const RemoteProviderModelSchema = z
  .object({
    modelKey: z.string(),
    displayName: z.string().optional(),
    contextWindow: z.number().int().positive().optional(),
    maxOutputTokens: z.number().int().positive().optional(),
    capabilities: z.record(z.string(), z.unknown()).optional(),
    mode: z.string(),
    inputModalities: z.array(z.string()).nullable(),
    outputModalities: z.array(z.string()).nullable(),
    raw: z.record(z.string(), z.unknown()),
  })
  .passthrough()

export type RemoteProviderModel = z.infer<typeof RemoteProviderModelSchema>

export const ProviderListModelsRequestSchema = z.object({
  /** 已保存的供应商：网关自己读 kind/baseUrl/key */
  providerId: z.string().min(1).max(32).optional(),
  /** 未保存先测：显式传配置（providerId 存在时以库里为准） */
  kind: z.string().min(1).optional(),
  baseUrl: z.string().nullable().optional(),
  apiKey: z.string().optional(),
})

export type ProviderListModelsRequest = z.infer<typeof ProviderListModelsRequestSchema>

export const ProviderListModelsResponseSchema = z.object({
  models: z.array(RemoteProviderModelSchema),
  endpoint: z.string(),
})

export type ProviderListModelsResponse = z.infer<typeof ProviderListModelsResponseSchema>

export const ProviderProbeRequestSchema = ProviderListModelsRequestSchema
export type ProviderProbeRequest = ProviderListModelsRequest

export const ProviderProbeResponseSchema = z.object({
  ok: z.boolean(),
  modelCount: z.number().int().nonnegative(),
  error: z.string().nullable(),
  endpoint: z.string(),
  durationMs: z.number().int().nonnegative(),
})

export type ProviderProbeResponse = z.infer<typeof ProviderProbeResponseSchema>
