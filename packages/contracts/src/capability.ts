import { z } from 'zod'

/**
 * 能力接入协议 v1 的契约（见 `docs/design/capability-protocol.md`）。
 *
 * 三条硬规则写在这里，别在调用方各写一份：
 * 1. 规范 key = `服务名/工具名`，**由网关拼、由网关拆**；
 * 2. 模型面名字 = `服务名__工具名`（OpenAI / Anthropic 的工具名不收 `/`）；
 * 3. 工具名只需在服务内唯一，服务名全局唯一即 namespace。
 */

/** 服务名（namespace）：小写字母数字与连字符，≤ 24 */
export const SERVICE_NAME_REGEX = /^[a-z0-9][a-z0-9-]{0,23}$/
/** 工具名：小写字母数字与连字符，≤ 32，且不允许连续双下划线（模型面反解析靠它） */
export const TOOL_NAME_REGEX = /^(?!.*__)[a-z0-9][a-z0-9-]{0,31}$/
/** 实例 id：允许大小写、数字、`:` `.` `_` `-`（hostname:pid、k8s pod 名都能表达） */
export const INSTANCE_ID_REGEX = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/

/** 规范 key 总长上限；`ai_tools.tool_key` 是 varchar(64)，留余量 */
export const MAX_CAPABILITY_KEY_LENGTH = 60

export const isServiceName = (value: string): boolean => SERVICE_NAME_REGEX.test(value)
export const isToolName = (value: string): boolean => TOOL_NAME_REGEX.test(value)

/**
 * 能力 key 就是**工具自己的名字**（`xxx-xxx` 扁平形式）。
 *
 * 服务是「一组工具」的登记单位（1:N），不再把服务名拼进 key；
 * 网关用 key → 服务的索引路由。跨服务重名在登记时拒绝。
 */
export const isCapabilityKey = (value: string): boolean =>
  TOOL_NAME_REGEX.test(value) && value.length <= 60

export const ServiceProbeSchema = z.object({
  state: z.enum(['unknown', 'up', 'down']).default('unknown'),
  failures: z.number().int().nonnegative().default(0),
  successes: z.number().int().nonnegative().default(0),
  lastProbedAt: z.number().int().nonnegative().default(0),
})

export type ServiceProbe = z.infer<typeof ServiceProbeSchema>

export const CapabilityRiskSchema = z.enum(['read', 'write'])
export const CapabilityScopeSchema = z.enum(['all', 'user', 'admin', 'agent'])
export type CapabilityScope = z.infer<typeof CapabilityScopeSchema>
export const CapabilityModeSchema = z.enum(['sync', 'task'])
export const CapabilityOwnerSchema = z.enum(['session', 'user', 'tenant'])
export const CapabilityPaginationSchema = z.enum(['none', 'cursor'])
export const ServiceSourceSchema = z.enum(['code', 'manual'])
export const ServiceStatusSchema = z.enum(['draft', 'active', 'disabled'])

/**
 * 服务侧的原生协议。
 *
 * - `capability`：本仓的能力协议（内部服务只有这一种）；
 * - `mcp`：外部服务的 MCP 接入（当前只落标识与目录治理，网关适配器待建）。
 */
export const ServiceProtocolSchema = z.enum(['capability', 'mcp'])

export type ServiceProtocol = z.infer<typeof ServiceProtocolSchema>

/** 执行声明：默认同步；`task` 才需要 owner / yield / wait / cancel */
const CapabilityExecutionObject = z.object({
  mode: CapabilityModeSchema.default('sync'),
  /** 执行位置：`host` 平台侧 / `workspace` 工作区（执行面按它路由） */
  where: z.enum(['host', 'workspace']).default('host'),
  owner: CapabilityOwnerSchema.default('session'),
  yieldMs: z.number().int().nonnegative().default(45_000),
  wait: z
    .object({ maxWaitMs: z.number().int().nonnegative().default(0) })
    .default({ maxWaitMs: 0 }),
  cancel: z.enum(['supported', 'none']).default('none'),
  poll: z
    .object({ minIntervalMs: z.number().int().positive().default(1_000) })
    .default({ minIntervalMs: 1_000 }),
  maxRunMs: z.number().int().positive().max(86_400_000).default(1_800_000),
})

/** 不写 `execution` 时的默认值（同步、默认 30s） */
export const DEFAULT_CAPABILITY_EXECUTION = CapabilityExecutionObject.parse({})

export const CapabilityExecutionSchema = CapabilityExecutionObject.default(
  DEFAULT_CAPABILITY_EXECUTION,
)

export type CapabilityExecution = z.infer<typeof CapabilityExecutionSchema>

/** 一条能力声明（服务自己交上来的部分） */
export const CapabilityDeclSchema = z.object({
  tool: z.string().regex(TOOL_NAME_REGEX),
  title: z.string().min(1).max(64),
  description: z.string().min(1).max(900),
  inputSchema: z.record(z.string(), z.unknown()).default({ type: 'object' }),
  risk: CapabilityRiskSchema.default('read'),
  idempotent: z.boolean().default(false),
  scope: CapabilityScopeSchema.default('all'),
  allowedAgents: z.array(z.string().min(1)).optional(),
  timeoutMs: z.number().int().positive().max(360_000).default(30_000),
  pagination: CapabilityPaginationSchema.default('none'),
  tags: z.array(z.string().min(1)).default([]),
  execution: CapabilityExecutionSchema,
  /**
   * 提供方的原始工具名（只有 MCP 这类外部协议需要）。
   *
   * 模型面/审计用扁平的 `tool`（受 §3.4 字符规则约束）；MCP 的工具名常带 `_` 或大写，
   * 网关把它们归一成合法 key 的同时，用这个字段记住原名去调用。
   */
  remoteTool: z.string().min(1).max(128).optional(),
})

export type CapabilityDecl = z.infer<typeof CapabilityDeclSchema>

/** 内部服务的实例：地址 + 并发上限（心跳再带 active） */
export const ServiceInstanceSchema = z.object({
  instanceId: z.string().regex(INSTANCE_ID_REGEX),
  endpoint: z
    .string()
    .url()
    .refine((value) => /^https?:\/\//.test(value), '实例地址必须是 http(s)'),
  maxConcurrency: z.number().int().positive().max(1_024).default(32),
})

export type ServiceInstance = z.infer<typeof ServiceInstanceSchema>

/**
 * 登记请求：服务清单 + （内部服务）本实例信息。
 *
 * - `source='code'`（我们自己的服务）：必须带 `instance`，`baseUrl` 不填（地址由实例给）；
 * - `source='manual'`（外部团队）：必须带 `baseUrl`，没有实例概念。
 */
export const ServiceRegistrationSchema = z
  .object({
    protocolVersion: z.literal(1).default(1),
    service: z.string().regex(SERVICE_NAME_REGEX),
    title: z.string().min(1).max(64),
    description: z.string().max(500).optional(),
    owner: z.string().min(1).max(128),
    source: ServiceSourceSchema.default('code'),
    protocol: ServiceProtocolSchema.default('capability'),
    /** 后台登记可以先落 `draft`，自检通过后再切 `active`；内部服务默认 active */
    status: ServiceStatusSchema.default('active'),
    baseUrl: z.string().url().optional(),
    healthPath: z.string().min(1).max(128).default('/healthz'),
    auth: z
      .object({
        mode: z.enum(['none', 'service-token', 'gateway-injected']).default('service-token'),
        header: z.string().min(1).max(64).default('authorization'),
        /** 仅后台登记外部服务时使用；网关存起来、调用时注入，不进目录、不回显 */
        credential: z.string().min(1).max(4096).optional(),
      })
      .optional(),
    allowHttp: z.boolean().default(false),
    instance: ServiceInstanceSchema.optional(),
    capabilities: z.array(CapabilityDeclSchema).min(1),
  })
  .superRefine((value, ctx) => {
    if (value.source === 'manual' && !value.baseUrl) {
      ctx.addIssue({ code: 'custom', path: ['baseUrl'], message: '外部服务必须提供 baseUrl' })
    }
    if (value.source === 'code' && !value.instance) {
      ctx.addIssue({ code: 'custom', path: ['instance'], message: '内部服务必须带上本实例信息' })
    }
    // 内部服务只说能力协议：MCP 标识只用于外部服务（适配器待建）
    if (value.source === 'code' && value.protocol === 'mcp') {
      ctx.addIssue({
        code: 'custom',
        path: ['protocol'],
        message: '内部服务只支持能力协议，MCP 只用于外部手工登记的服务',
      })
    }
    const tools = new Set<string>()
    for (const capability of value.capabilities) {
      if (tools.has(capability.tool)) {
        ctx.addIssue({
          code: 'custom',
          path: ['capabilities'],
          message: `工具名在服务内重复：${capability.tool}`,
        })
      }
      tools.add(capability.tool)
    }
  })

export type ServiceRegistration = z.infer<typeof ServiceRegistrationSchema>
export type ServiceRegistrationInput = z.input<typeof ServiceRegistrationSchema>

/** 网关注册表里的一条实例 */
export const RegisteredInstanceSchema = ServiceInstanceSchema.extend({
  active: z.number().int().nonnegative().default(0),
  lastSeenAt: z.number().int().nonnegative(),
  draining: z.boolean().default(false),
})

export type RegisteredInstance = z.infer<typeof RegisteredInstanceSchema>

/** 网关注册表里的一条服务（事实源快照） */
export const RegisteredServiceSchema = z.object({
  service: z.string(),
  title: z.string(),
  description: z.string().optional(),
  owner: z.string(),
  source: ServiceSourceSchema,
  /** 旧持久化记录没有这个字段：`safeParse` 按默认值补齐为能力协议 */
  protocol: ServiceProtocolSchema.default('capability'),
  baseUrl: z.string().optional(),
  healthPath: z.string(),
  auth: z
    .object({
      mode: z.enum(['none', 'service-token', 'gateway-injected']),
      header: z.string(),
      /** 密钥存单独的 key，这里只标记有没有 */
      hasCredential: z.boolean().default(false),
    })
    .optional(),
  allowHttp: z.boolean(),
  status: ServiceStatusSchema,
  capabilities: z.array(CapabilityDeclSchema),
  /** 不在最新清单里的工具名：保留配置行，但不进目录 */
  deprecated: z.array(z.string()),
  instances: z.record(z.string(), RegisteredInstanceSchema),
  probe: ServiceProbeSchema.default({
    state: 'unknown',
    failures: 0,
    successes: 0,
    lastProbedAt: 0,
  }),
  version: z.number().int().positive(),
  updatedAt: z.number().int().nonnegative(),
})

export type RegisteredService = z.infer<typeof RegisteredServiceSchema>

/** 注册结果：能力和 key 都由网关拼好再返回 */
export const ServiceRegisterResultSchema = z.object({
  accepted: z.literal(true),
  service: z.string(),
  version: z.number().int().positive(),
  added: z.array(z.string()),
  changed: z.array(z.string()),
  removed: z.array(z.string()),
  capabilities: z.array(z.object({ tool: z.string(), key: z.string(), name: z.string() })),
})

export type ServiceRegisterResult = z.infer<typeof ServiceRegisterResultSchema>

export const InstanceHeartbeatSchema = z.object({
  service: z.string().regex(SERVICE_NAME_REGEX),
  instanceId: z.string().regex(INSTANCE_ID_REGEX),
  active: z.number().int().nonnegative().default(0),
})

export type InstanceHeartbeat = z.infer<typeof InstanceHeartbeatSchema>

export const InstanceDeregisterSchema = z.object({
  service: z.string().regex(SERVICE_NAME_REGEX),
  instanceId: z.string().regex(INSTANCE_ID_REGEX),
})

export type InstanceDeregistration = z.infer<typeof InstanceDeregisterSchema>

/**
 * MCP 发现（网关作为 MCP client，去对方 server 拉工具清单）。
 *
 * 只支持 HTTP 型（Streamable HTTP / JSON-RPC 2.0，一次 POST 一次响应）；stdio 需要本地适配器，v1 不做。
 */
export const McpDiscoverSchema = z.object({
  url: z.string().url(),
  /** 额外的请求头（鉴权等）；值不进日志 */
  headers: z.record(z.string(), z.string()).optional(),
  /** 联调允许 http（生产默认 https） */
  allowHttp: z.boolean().default(false),
})

export type McpDiscover = z.infer<typeof McpDiscoverSchema>

export const McpToolSchema = z.object({
  /** 归一后的扁平 key（模型面/审计用） */
  key: z.string(),
  /** 对方的原始工具名（调用时原样传回） */
  remoteTool: z.string().min(1),
  title: z.string().min(1),
  description: z.string(),
  inputSchema: z.record(z.string(), z.unknown()),
})

export type McpTool = z.infer<typeof McpToolSchema>

export const McpDiscoverResultSchema = z.object({
  protocolVersion: z.string(),
  tools: z.array(McpToolSchema),
})

export type McpDiscoverResult = z.infer<typeof McpDiscoverResultSchema>

export const ServiceDeregisterSchema = z.object({
  service: z.string().regex(SERVICE_NAME_REGEX),
})

export const CapabilityServiceStatusSchema = z.object({
  service: z.string().regex(SERVICE_NAME_REGEX),
  status: ServiceStatusSchema,
})

export type CapabilityServiceStatus = z.infer<typeof CapabilityServiceStatusSchema>

export type ServiceDeregistration = z.infer<typeof ServiceDeregisterSchema>

/** 给模型 / 上游看的一条能力 */
export const CapabilityInfoSchema = z.object({
  key: z.string(),
  name: z.string(),
  service: z.string(),
  /** 能力来源：`code` = 我们自己的服务 / 网关内建，`manual` = 外部登记服务（MCP 等） */
  source: ServiceSourceSchema,
  tool: z.string(),
  title: z.string(),
  description: z.string(),
  inputSchema: z.record(z.string(), z.unknown()),
  risk: CapabilityRiskSchema,
  scope: CapabilityScopeSchema,
  available: z.boolean(),
  tags: z.array(z.string()),
})

export type CapabilityInfo = z.infer<typeof CapabilityInfoSchema>

export const CapabilityListRequestSchema = z.object({
  caller: z.object({
    userId: z.string().nullable().optional(),
    isAdmin: z.boolean().optional(),
    agentKey: z.string().min(1),
    rootAgentKey: z.string().min(1),
    conversationId: z.string().min(1).default('catalog'),
    runId: z.string().min(1).default('catalog'),
    depth: z.number().int().nonnegative().default(0),
  }),
  agentKey: z.string().min(1),
  depth: z.number().int().nonnegative().default(0),
})

export type CapabilityListRequest = z.infer<typeof CapabilityListRequestSchema>

export const CapabilityListResponseSchema = z.object({
  version: z.literal(1),
  capabilities: z.array(CapabilityInfoSchema),
})

export type CapabilityListResponse = z.infer<typeof CapabilityListResponseSchema>

/** 一次能力调用（发给服务的 body 由网关按协议 §7 组装） */
export const CapabilityInvokeRequestSchema = z.object({
  capability: z.string().min(1),
  /** 会话绑定的工作区（执行面直接用它，不必再查会话） */
  workspaceId: z.string().min(1).max(20).optional(),
  input: z.record(z.string(), z.unknown()).default({}),
  reason: z.string().optional(),
  caller: z.object({
    conversationId: z.string().min(1),
    runId: z.string().min(1),
    userId: z.string().nullable().optional(),
    isAdmin: z.boolean().optional(),
    agentKey: z.string().min(1),
    rootAgentKey: z.string().min(1),
    depth: z.number().int().nonnegative(),
  }),
  deadlineMs: z.number().int().positive().max(360_000).default(30_000),
  idempotencyKey: z.string().max(128).optional(),
})

export type CapabilityInvokeRequest = z.infer<typeof CapabilityInvokeRequestSchema>

/** 任务执行状态（协议固定六态） */
export const CapabilityTaskStateSchema = z.enum([
  'pending',
  'running',
  'succeeded',
  'failed',
  'canceled',
  'expired',
])

export type CapabilityTaskState = z.infer<typeof CapabilityTaskStateSchema>

/** 受理时返回的任务句柄 */
export const CapabilityTaskHandleSchema = z.object({
  id: z.string().min(1),
  state: CapabilityTaskStateSchema,
  data: z.unknown().optional(),
  pollAfterMs: z.number().int().positive().optional(),
})

export type CapabilityTaskHandle = z.infer<typeof CapabilityTaskHandleSchema>

/** `POST /tasks/get` 的入参；`waitMs` 是长轮询窗口 */
export const CapabilityTaskQuerySchema = z.object({
  taskId: z.string().min(1).max(128),
  waitMs: z.number().int().positive().max(120_000).optional(),
})

export type CapabilityTaskQuery = z.infer<typeof CapabilityTaskQuerySchema>

export const CapabilityTaskCancelSchema = z.object({
  taskId: z.string().min(1).max(128),
})

export type CapabilityTaskCancel = z.infer<typeof CapabilityTaskCancelSchema>

/** 停止一轮对话：级联取消**本轮发起的** `owner=session` 任务（协议 §9） */
export const CapabilityRunCancelSchema = z.object({
  runId: z.string().min(1).max(128),
})

export type CapabilityRunCancel = z.infer<typeof CapabilityRunCancelSchema>

export const CapabilityRunCancelResultSchema = z.object({
  /** 本轮记录过的任务数 */
  targets: z.number().int().nonnegative(),
  /** 取消后确认为 `canceled` 的数量 */
  canceled: z.number().int().nonnegative(),
})

export type CapabilityRunCancelResult = z.infer<typeof CapabilityRunCancelResultSchema>

/** 服务返回的任务快照（协议 §9） */
export const CapabilityTaskSnapshotSchema = z.object({
  version: z.literal(1),
  id: z.string().min(1),
  state: CapabilityTaskStateSchema,
  data: z.unknown().optional(),
  progress: z.object({ percent: z.number().optional(), message: z.string().optional() }).optional(),
  result: z.object({ ok: z.literal(true), data: z.unknown() }).optional(),
  error: z.object({ reason: z.string().min(1), message: z.string().min(1) }).optional(),
  nextCursor: z.string().optional(),
})

export type CapabilityTaskSnapshot = z.infer<typeof CapabilityTaskSnapshotSchema>

/** 服务返回的三形态之一 */
export const CapabilityInvokeResponseSchema = z.object({
  version: z.literal(1),
  ok: z.boolean(),
  data: z.unknown().optional(),
  reason: z.string().min(1).optional(),
  message: z.string().optional(),
  hint: z.string().optional(),
  retryable: z.boolean().optional(),
  task: CapabilityTaskHandleSchema.optional(),
})

export type CapabilityInvokeResponse = z.infer<typeof CapabilityInvokeResponseSchema>

/** 网关返回给上游的调用结论 */
export const CapabilityInvokeResultSchema = z.object({
  version: z.literal(1),
  requestId: z.string(),
  capability: z.string(),
  service: z.string(),
  instanceId: z.string(),
  durationMs: z.number().int().nonnegative(),
  task: CapabilityTaskHandleSchema.optional(),
  outcome: z.discriminatedUnion('ok', [
    z.object({ ok: z.literal(true), data: z.unknown() }),
    z.object({
      ok: z.literal(false),
      reason: z.string().min(1),
      message: z.string().min(1),
      hint: z.string().optional(),
      retryable: z.boolean().optional(),
    }),
  ]),
})

export type CapabilityInvokeResult = z.infer<typeof CapabilityInvokeResultSchema>

/** 走网关执行的工具（其余是本地编排工具：plan / agent / skill） */
export const REMOTE_TOOL_KEYS: ReadonlySet<string> = new Set([
  'bash',
  'web-fetch',
  'web-search',
  'web-request',
  'memory-save',
  'memory-search',
  'memory-forget',
  'file-list',
  'read-file',
  'write-file',
  'append-file',
  'replace-file',
  'file-search',
  'file-submit',
  'file-download',
  'workspace-files',
  'read-tool-result',
  // 网关内建：任务结果轮询 / 取消（回调已取消，轮询是唯一出路）
  'wait-task',
  'cancel-task',
  'tool-search',
])

export const isRemoteToolKey = (key: string): boolean => REMOTE_TOOL_KEYS.has(key)
