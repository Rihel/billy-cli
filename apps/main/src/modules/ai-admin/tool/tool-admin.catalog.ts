import { Inject, Injectable } from '@nestjs/common'
import { AgentRuntimeClient, CapabilityGatewayClient } from '@repo/internal-sdk'
import { FileConfigSchema } from '@repo/ai-data'
import type { CapabilityInfo } from '@repo/contracts'
import { AppLogger } from '@repo/kits'
import { ToolCategory } from '@repo/shared'
import type { AgentToolMetaModel } from '@repo/shared'
import { BROWSER_UA } from '@repo/web-runtime'
import { z } from 'zod'

/**
 * 工具管理（`/ai-tool/*`）的**控制面元数据目录**。
 *
 * 基础信息不再在 main 存快照：**运行时内建工具问 agent-runtime**（`/internal/agent/tools`），
 * **服务能力问能力网关**（`/v1/capabilities/list`）。main 只保留「配置的合法性」
 * （字段类型、默认值、秘钥字段名）—— 那是控制面自己的声明，执行侧不关心。
 *
 * 口径：main 侧不执行工具，这里只回答"页面能改什么、默认值是什么、值合不合法"。
 */

/** zod 定义的宽类型（不同工具的配置输出形状各异，这里只关心 `safeParse`） */
type AnySchema = z.ZodType<any>

/** 秘钥字段的**声明**（不含 hint；hint 从库里的明文实时派生） */
export interface ToolSecretFieldDecl {
  readonly name: string
  readonly label: string
  /** 必填的秘钥缺了就调不了（前端据此标红星） */
  readonly required?: boolean
}

/** 控制面看到一个工具所需的全部不可变元数据 */
export interface ToolAdminSpec {
  readonly key: string
  readonly title: string
  readonly description: string
  readonly category: string
  readonly scope: string
  /** 配置定义（每个字段都有默认值；`parse({})` 必须成功） */
  readonly config: AnySchema
  /** 秘钥定义（字段一律可选，默认状态是"未配置"） */
  readonly secrets?: AnySchema
  readonly secretFields: readonly ToolSecretFieldDecl[]
  /** 参数定义的 JSON Schema（含必填 `reason`） */
  readonly paramSchema: Record<string, unknown> | null
  /** 声明了分页才有值（目前只有 bash） */
  readonly pageBytes: number | null
  /** 能否被后台改（runtime 工具为 false） */
  readonly editable: boolean
  /** 运行时自带、不进 `ai_tools`（只读展示） */
  readonly runtime: boolean
}

// ─────────────────────────── 配置 / 秘钥声明 ───────────────────────────

/** `bash` 的配置（与服务侧声明的默认值一致） */
const BashConfig = z.object({
  enabled: z.boolean().default(true),
  timeoutMs: z.number().int().positive().default(300_000),
  maxOutputBytes: z
    .number()
    .int()
    .positive()
    .default(64 * 1024),
})

/** `web-fetch` / `web-request` 共用的抓取配置 */
const WebConfig = z.object({
  enabled: z.boolean().default(true),
  timeoutMs: z.number().int().positive().default(20_000),
  maxBytes: z
    .number()
    .int()
    .positive()
    .default(2 * 1024 * 1024),
  pageLines: z.number().int().positive().default(1000),
  cacheTtlMs: z
    .number()
    .int()
    .positive()
    .default(10 * 60_000),
  userAgent: z.string().min(16).default(BROWSER_UA),
  allowPrivateNetwork: z.boolean().default(false),
})

/** `web-search` 的配置（搜索接口与抓取分开：地址与预算都不一样） */
const WebSearchConfig = z.object({
  enabled: z.boolean().default(true),
  baseUrl: z.string().url().max(255).default('https://api.deepseek.com'),
  timeoutMs: z.number().int().positive().default(15_000),
  allowPrivateNetwork: z.boolean().default(false),
})

/** `web-search` 的秘钥（留空 = 复用当前会话 DeepSeek 官方模型的密钥） */
const WebSearchSecrets = z.object({
  apiKey: z.string().min(1).optional(),
})

/** `run-sub-agent` 的配置（0 = 沿用部署默认） */
const SubAgentConfig = z.object({
  maxPerRun: z.number().int().nonnegative().default(0),
  maxDepth: z.number().int().nonnegative().default(0),
  maxSteps: z.number().int().nonnegative().default(0),
  timeoutMs: z.number().int().nonnegative().default(0),
})

/** `read-tool-result` 的配置 */
const ReadToolResultConfig = z.object({
  pageBytes: z
    .number()
    .int()
    .positive()
    .default(8 * 1024),
})

/** 记忆工具只有一个能力开关 */
const MemoryConfig = z.object({
  enabled: z.boolean().default(true),
})

/** 没有可配项的工具（规划 / 技能） */
const EmptyConfig = z.object({})

/** 文件工具组（九个工具共用 `@repo/ai-data` 的同一份配置 schema） */
const FILE_TOOL_KEYS = new Set([
  'file-submit',
  'file-download',
  'file-list',
  'read-file',
  'file-search',
  'workspace-files',
  'write-file',
  'replace-file',
  'append-file',
])

/** 按工具 key 取配置定义（控制面声明；执行侧不关心） */
const configSchemaOf = (key: string): AnySchema => {
  if (key === 'bash') return BashConfig
  if (key === 'web-search') return WebSearchConfig
  if (key === 'web-fetch' || key === 'web-request') return WebConfig
  if (key === 'run-sub-agent') return SubAgentConfig
  if (key === 'read-tool-result') return ReadToolResultConfig
  if (FILE_TOOL_KEYS.has(key)) return FileConfigSchema
  if (key.startsWith('memory-')) return MemoryConfig
  // 规划 / 技能：没有可配项（空对象 schema 会剔除未知键，与运行时声明一致）
  return EmptyConfig
}

/** 按工具 key 取秘钥定义（目前只有 web-search 有秘钥） */
const secretsSchemaOf = (key: string): AnySchema | undefined =>
  key === 'web-search' ? WebSearchSecrets : undefined

/** 秘钥字段元信息（页面渲染输入框用；不含 hint） */
const SECRET_FIELDS: Readonly<Record<string, readonly ToolSecretFieldDecl[]>> = {
  'web-search': [
    {
      name: 'apiKey',
      label: 'DeepSeek API Key（留空则复用当前会话 DeepSeek 官方模型的密钥）',
    },
  ],
}

/** 声明了分页的工具 */
const PAGE_BYTES: Readonly<Record<string, number>> = {
  bash: 8 * 1024,
}

// ─────────────────────────── runtime 工具（只读） ───────────────────────────

/**
 * 运行时自带（Mastra 的技能工具）：不进 `ai_tools`、网关拦不到、也没有开关与限额。
 *
 * 只读注册，`update` / `reset` 一律拒绝（与旧 `ai-tool` 服务同一口径）。
 */
const RUNTIME_SPECS: readonly ToolAdminSpec[] = [
  {
    key: 'skill',
    title: '激活技能（运行时自带）',
    description: '读取技能的完整说明（Mastra 在 Agent 层自动挂载，不受本工程的开关与限额控制）',
  },
  {
    key: 'skill_search',
    title: '检索技能内容（运行时自带）',
    description: '在技能正文里做关键词检索（同上，Mastra 自带）',
  },
  {
    key: 'skill_read',
    title: '读取技能文件（运行时自带）',
    description: '读取技能目录下的 references / scripts / assets（支持行区间，Mastra 自带）',
  },
].map((tool) => ({
  ...tool,
  category: ToolCategory._source.Runtime.value,
  scope: 'all',
  config: EmptyConfig,
  secretFields: [],
  paramSchema: null,
  pageBytes: null,
  editable: false,
  runtime: true,
}))

/** 能力目录条目 → 控制面元数据 */
const specOfCapability = (capability: CapabilityInfo): ToolAdminSpec => ({
  key: capability.key,
  title: capability.title,
  description: capability.description,
  category: capability.source === 'manual' ? 'external' : 'core',
  scope: capability.scope,
  config: configSchemaOf(capability.key),
  ...(secretsSchemaOf(capability.key) ? { secrets: secretsSchemaOf(capability.key) } : {}),
  secretFields: SECRET_FIELDS[capability.key] ?? [],
  paramSchema: capability.inputSchema,
  pageBytes: PAGE_BYTES[capability.key] ?? null,
  editable: true,
  runtime: false,
})

/** 运行时内建工具 → 控制面元数据 */
const specOfRuntimeTool = (tool: AgentToolMetaModel): ToolAdminSpec => ({
  key: tool.key,
  title: tool.title,
  description: tool.description,
  category: tool.category,
  scope: tool.scope,
  config: configSchemaOf(tool.key),
  ...(secretsSchemaOf(tool.key) ? { secrets: secretsSchemaOf(tool.key) } : {}),
  secretFields: SECRET_FIELDS[tool.key] ?? [],
  paramSchema: tool.paramSchema,
  pageBytes: PAGE_BYTES[tool.key] ?? null,
  editable: true,
  runtime: false,
})

/** 目录缓存：能力登记 / 工具声明变化后最多 5 秒反映到页面 */
const CACHE_TTL_MS = 5_000

/**
 * 控制面工具目录：**运行时内建工具 + 能力目录**，main 不再持有 manifest 快照。
 *
 * 任何一侧不可用都只降级（记 warn），不让整个后台页打不开。
 */
@Injectable()
export class ToolAdminCatalog {
  private cached: { at: number; specs: readonly ToolAdminSpec[] } | null = null

  constructor(@Inject(AppLogger) private readonly logger: AppLogger) {}

  /** 全部工具（按 key 排序；路径稳定，前端不会跳） */
  async specs(): Promise<readonly ToolAdminSpec[]> {
    if (this.cached && Date.now() - this.cached.at < CACHE_TTL_MS) return this.cached.specs
    const [runtimeTools, capabilities] = await Promise.all([
      this.fetchRuntimeTools(),
      this.fetchCapabilities(),
    ])

    const byKey = new Map<string, ToolAdminSpec>()
    // 运行时内建优先（本地有完整声明，含配置 schema）
    for (const tool of runtimeTools) byKey.set(tool.key, specOfRuntimeTool(tool))
    for (const capability of capabilities) {
      if (byKey.has(capability.key)) continue
      byKey.set(capability.key, specOfCapability(capability))
    }
    for (const spec of RUNTIME_SPECS) byKey.set(spec.key, spec)

    const specs = [...byKey.values()].sort((left, right) => left.key.localeCompare(right.key))
    this.cached = { at: Date.now(), specs }
    return specs
  }

  /** 按 key 取元数据（未知 key 返回 undefined，由 service 翻成 3407） */
  async find(key: string): Promise<ToolAdminSpec | undefined> {
    return (await this.specs()).find((spec) => spec.key === key)
  }

  private async fetchRuntimeTools(): Promise<AgentToolMetaModel[]> {
    const baseUrl = process.env.AGENT_RUNTIME_URL?.trim()
    if (!baseUrl) return []
    try {
      const client = new AgentRuntimeClient({
        baseUrl,
        token: process.env.AGENT_INTERNAL_TOKEN?.trim() || 'dev-internal-token',
        timeoutMs: 5_000,
      })
      return (await client.tools()).tools
    } catch (error) {
      this.logger.warn('ai.tool_meta.runtime_unavailable', {
        reason: error instanceof Error ? error.message : String(error),
      })
      return []
    }
  }

  private async fetchCapabilities(): Promise<CapabilityInfo[]> {
    const baseUrl = process.env.TOOL_GATEWAY_URL?.trim()
    if (!baseUrl) return []
    try {
      const client = new CapabilityGatewayClient({
        baseUrl,
        token:
          process.env.TOOL_GATEWAY_TOKEN?.trim() ||
          process.env.TOOL_INTERNAL_TOKEN?.trim() ||
          'dev-tool-token',
        timeoutMs: 5_000,
      })
      const caller = {
        conversationId: 'tool-admin',
        runId: 'tool-admin',
        isAdmin: true,
        agentKey: 'assistant',
        rootAgentKey: 'assistant',
        depth: 0,
      }
      const response = await client.listCapabilities({ caller, agentKey: 'assistant', depth: 0 })
      return response.capabilities
    } catch (error) {
      this.logger.warn('ai.tool_meta.gateway_unavailable', {
        reason: error instanceof Error ? error.message : String(error),
      })
      return []
    }
  }
}

/** 代码默认值：`config.parse({})`。失败说明声明漏了 `.default()` —— 启动期就该炸 */
export const defaultsOf = (spec: ToolAdminSpec): Record<string, unknown> => {
  const parsed = spec.config.safeParse({})
  if (!parsed.success) {
    throw new Error(
      `工具 ${spec.key} 的配置没有给全默认值：config.parse({}) 失败 —— ${parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '(根)'}: ${issue.message}`)
        .join('；')}`,
    )
  }
  return parsed.data as Record<string, unknown>
}

/**
 * 库里的稀疏配置 + 代码默认值 = 页面展示的完整配置。
 *
 * `undefined` 视为"没给"（不覆盖默认值）；`null` 是调用方明确给的值，保留。
 */
export const mergeConfig = (
  spec: ToolAdminSpec,
  stored: Record<string, unknown> | null | undefined,
): Record<string, unknown> => {
  const defaults = defaultsOf(spec)
  const given = Object.fromEntries(
    Object.entries(stored ?? {}).filter(([, value]) => value !== undefined),
  )
  return { ...defaults, ...given }
}
