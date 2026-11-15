import { z } from 'zod'

/**
 * 内部工具契约版本。
 *
 * 只加可选字段不必升版本；删字段 / 改语义必须升，并在网关同时接受相邻两版一个发布周期。
 */
export const TOOL_CONTRACT_VERSION = 1 as const

/** 调用方身份（来自 facade 的运行时信封，**不要再从请求体里读用户身份**） */
export const ToolCallerSchema = z.object({
  conversationId: z.string().min(1),
  runId: z.string().min(1),
  userId: z.string().nullable().optional(),
  isAdmin: z.boolean().optional(),
  agentKey: z.string().min(1),
  rootAgentKey: z.string().min(1),
  depth: z.number().int().nonnegative(),
})

export type ToolCaller = z.infer<typeof ToolCallerSchema>

/**
 * 一次工具调用。
 *
 * `toolCallId` 允许 null：Mastra 在某些路径上不提供调用 id；它只用于幂等 / 审计关联，
 * 不参与执行正确性。
 */
/** 运行时生效配置（由 gateway 从 ai_tools 读；secrets 只在内部网络传输） */
export const ToolRuntimeSettingsSchema = z.object({
  config: z.record(z.string(), z.unknown()).default({}),
  limits: z.record(z.string(), z.unknown()).default({}),
  secrets: z.record(z.string(), z.string()).default({}),
  version: z.string().default('code-default'),
})

export type ToolRuntimeSettings = z.infer<typeof ToolRuntimeSettingsSchema>

export const ToolInvokeRequestSchema = z.object({
  version: z.literal(TOOL_CONTRACT_VERSION),
  requestId: z.string().min(1).max(128),
  toolKey: z.string().min(1).max(128),
  toolCallId: z.string().max(128).nullable(),
  input: z.record(z.string(), z.unknown()),
  caller: ToolCallerSchema,
  /** 工作区 / 文件归属的根会话；子会话共享父工作区时传父 id */
  workspaceConversationId: z.string().min(1).optional(),
  /** 网关合并后的生效配置；worker 只读，不落库、不进日志 */
  settings: ToolRuntimeSettingsSchema.optional(),
  /** 本次调用的墙钟上限（含排队）；网关与 worker 都不能超过它（5 分钟命令 + 传输余量） */
  deadlineMs: z.number().int().positive().max(360_000),
  /** 会话选择的文件权限；worker 只接受沙箱内的两档 */
  fileAccess: z.enum(['read-only', 'workspace-write']).optional(),
})

export type ToolInvokeRequest = z.infer<typeof ToolInvokeRequestSchema>

/** 工具结论：成功带 data，失败带可读原因（与 `ToolOutcome` 同形） */
export const ToolOutcomeSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    data: z.unknown(),
  }),
  z.object({
    ok: z.literal(false),
    reason: z.string().min(1),
    message: z.string().min(1),
    hint: z.string().optional(),
    retryable: z.boolean().optional(),
  }),
])

export type ToolOutcome = z.infer<typeof ToolOutcomeSchema>

/** 工具调用的响应（先 JSON；流式 progress 在下一版加 SSE） */
export const ToolInvokeResponseSchema = z.object({
  version: z.literal(TOOL_CONTRACT_VERSION),
  requestId: z.string(),
  workerId: z.string(),
  durationMs: z.number().int().nonnegative(),
  outcome: ToolOutcomeSchema,
})

export type ToolInvokeResponse = z.infer<typeof ToolInvokeResponseSchema>

/** 工具清单里的一项（给编排层 / 模型看的元数据，绝不含密钥） */
export const ToolManifestSchema = z.object({
  key: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  category: z.string().min(1),
  scope: z.enum(['all', 'user', 'admin', 'agent']),
  executor: z.string().min(1),
  /** 给模型的参数 JSON Schema（已含必填 reason） */
  params: z.record(z.string(), z.unknown()),
  version: z.number().int().positive(),
})

export type ToolManifest = z.infer<typeof ToolManifestSchema>

export const ToolListRequestSchema = z.object({
  version: z.literal(TOOL_CONTRACT_VERSION),
  caller: ToolCallerSchema,
  agentKey: z.string().min(1),
  depth: z.number().int().nonnegative(),
})

export type ToolListRequest = z.infer<typeof ToolListRequestSchema>

export const ToolListResponseSchema = z.object({
  version: z.literal(TOOL_CONTRACT_VERSION),
  tools: z.array(ToolManifestSchema),
})

export type ToolListResponse = z.infer<typeof ToolListResponseSchema>
