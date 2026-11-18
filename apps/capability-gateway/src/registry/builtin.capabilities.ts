import {
  CapabilityDeclSchema,
  DEFAULT_CAPABILITY_EXECUTION,
  type CapabilityDecl,
} from '@repo/contracts'

/**
 * **网关内建能力**：任务结果的轮询与取消。
 *
 * 它们不属于任何服务的清单（proto §10.1）：登记时被保留、目录里始终可用、调用由网关自己处理
 * （`wait-task` → `/v1/tasks/get`，`cancel-task` → `/v1/tasks/cancel`），不转发给服务。
 *
 * 为什么放在网关而不是某个服务：任务索引（`taskId → 实例`）本来就由网关持有，服务只知道自己那份任务；
 * 让任意一个服务来承接这张表都会多一份要同步的状态。回调取消后，轮询是拿长任务结果的唯一出路。
 */
export const GATEWAY_SERVICE = 'gateway'

/** 内建能力的工具名：登记时保留，不允许服务占用 */
export const BUILTIN_CAPABILITY_KEYS: ReadonlySet<string> = new Set([
  'wait-task',
  'cancel-task',
  'tool-search',
])

const WAIT_TASK_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    taskId: {
      type: 'string',
      minLength: 1,
      maxLength: 128,
      description: '受理时返回的任务 id',
    },
    waitMs: {
      type: 'integer',
      minimum: 1,
      maximum: 120000,
      description: '最多等多久（长轮询）；省略 = 立即返回当前快照',
    },
  },
  required: ['taskId'],
  additionalProperties: false,
} as const

const TOOL_SEARCH_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    query: {
      type: 'string',
      minLength: 1,
      maxLength: 200,
      description: '要找的工具做什么（自然语言，中文 / 英文都行）',
    },
    limit: {
      type: 'integer',
      minimum: 1,
      maximum: 20,
      default: 8,
      description: '返回几个候选（默认 8）',
    },
  },
  required: ['query'],
  additionalProperties: false,
} as const

const CANCEL_TASK_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    taskId: {
      type: 'string',
      minLength: 1,
      maxLength: 128,
      description: '要取消的任务 id',
    },
  },
  required: ['taskId'],
  additionalProperties: false,
} as const

export const BUILTIN_CAPABILITIES: readonly CapabilityDecl[] = [
  CapabilityDeclSchema.parse({
    tool: 'wait-task',
    title: '等任务结果',
    description:
      '查询一个长任务的当前状态；任务没结束时会最多等 waitMs。返回最新快照（state 六态 + data / result / error）。当前对话里的长命令（bash）受理后就用它拿结果。',
    inputSchema: WAIT_TASK_INPUT_SCHEMA,
    risk: 'read',
    idempotent: true,
    scope: 'all',
    timeoutMs: 120_000,
    tags: ['任务'],
    execution: { ...DEFAULT_CAPABILITY_EXECUTION, mode: 'sync' },
  }),
  CapabilityDeclSchema.parse({
    tool: 'cancel-task',
    title: '取消任务',
    description: '幂等取消一个还在跑的长任务；已到终态时返回当前快照，不报错。',
    inputSchema: CANCEL_TASK_INPUT_SCHEMA,
    risk: 'write',
    idempotent: true,
    scope: 'all',
    timeoutMs: 30_000,
    tags: ['任务'],
    execution: { ...DEFAULT_CAPABILITY_EXECUTION, mode: 'sync' },
  }),
  CapabilityDeclSchema.parse({
    tool: 'tool-search',
    title: '检索工具',
    description:
      '按关键词从能力目录里找工具；不确定该用哪个工具、或工具很多时先搜一下。返回命中的工具 key 与说明，之后直接调用那个工具。',
    inputSchema: TOOL_SEARCH_INPUT_SCHEMA,
    risk: 'read',
    idempotent: true,
    scope: 'all',
    timeoutMs: 10_000,
    tags: ['检索'],
    execution: { ...DEFAULT_CAPABILITY_EXECUTION, mode: 'sync' },
  }),
]

export const findBuiltinCapability = (key: string): CapabilityDecl | undefined =>
  BUILTIN_CAPABILITIES.find((capability) => capability.tool === key)
