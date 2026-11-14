import { FileConfigSchema } from '@repo/ai-data'
import { ToolCategory } from '@repo/shared'
import { ALL_TOOL_MANIFESTS } from '@repo/tool-catalog'
import { BROWSER_UA } from '@repo/web-runtime'
import { z } from 'zod'

/**
 * 工具管理（`/ai-tool/*`）的**代码侧元数据目录**。
 *
 * 为什么需要这一层：`ai_tools` 只存"可变的值"（开关 / 作用域 / 限额 / 配置 / 秘钥），
 * 标题 / 说明 / 参数定义由 `@repo/tool-catalog` 的 manifest 提供，而**配置的合法性**
 * （默认值、字段类型、秘钥字段）只有工具声明自己知道。main 的 ai-tool 模块不持有
 * agent loop / Mastra / 工具执行器，所以把控制面需要的那一份声明集中在这里：
 *
 * - **基础信息**（key / title / description / category / scope / params）**直接取 manifest**，
 *   不手抄第二份 —— 那是 `@repo/tool-catalog` 的职责；
 * - **配置 schema**：能从共享包复用的就复用（文件工具取 `@repo/ai-data` 的
 *   `FileConfigSchema`，与 worker / 运行时同一份）；其余工具的控制面声明在 main 侧只有
 *   这一处，字段与默认值对齐运行时工具声明；
 * - **秘钥只声明"有哪些字段"**，不存明文；读取时用 `hintOf` 从库里的明文派生提示串；
 * - **runtime 工具**（Mastra 自带的三个技能工具）不在 manifest 里，单独登记为只读。
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
  /** 参数定义的 JSON Schema（来自 manifest，已含必填 `reason`） */
  readonly paramSchema: Record<string, unknown> | null
  /** 声明了分页才有值（目前只有 bash） */
  readonly pageBytes: number | null
  /** 能否被后台改（runtime 工具为 false） */
  readonly editable: boolean
  /** 运行时自带、不进 `ai_tools`（只读展示） */
  readonly runtime: boolean
}

// ─────────────────────────── 配置 / 秘钥声明 ───────────────────────────

/** `bash` 的配置（与运行时工具声明同字段、同默认值） */
const BashConfig = z.object({
  enabled: z.boolean().default(true),
  timeoutMs: z.number().int().positive().default(15_000),
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

/** 按工具 key 取配置定义（`ai_tools` 不是 schema 来源，这里才是 main 控制面的声明处） */
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
 * 列在这里是为了"后台工具清单与模型手上的工具对得上账"；`editable=false`，
 * `update` / `reset` 一律拒绝（与旧 `ai-tool` 服务同一口径）。
 */
const RUNTIME_TOOL_METAS: readonly { key: string; title: string; description: string }[] = [
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
]

// ─────────────────────────── 组装 ───────────────────────────

/** 代码声明（manifest）→ 控制面元数据 */
const MANIFEST_SPECS: readonly ToolAdminSpec[] = ALL_TOOL_MANIFESTS.map((manifest) => ({
  key: manifest.key,
  title: manifest.title,
  description: manifest.description,
  category: manifest.category,
  scope: manifest.scope,
  config: configSchemaOf(manifest.key),
  ...(secretsSchemaOf(manifest.key) ? { secrets: secretsSchemaOf(manifest.key) } : {}),
  secretFields: SECRET_FIELDS[manifest.key] ?? [],
  paramSchema: manifest.params,
  pageBytes: PAGE_BYTES[manifest.key] ?? null,
  editable: true,
  runtime: false,
}))

/** runtime 自带工具 → 只读元数据 */
const RUNTIME_SPECS: readonly ToolAdminSpec[] = RUNTIME_TOOL_METAS.map((tool) => ({
  key: tool.key,
  title: tool.title,
  description: tool.description,
  category: ToolCategory._source.Runtime.value,
  scope: 'all',
  config: EmptyConfig,
  secretFields: [],
  paramSchema: null,
  pageBytes: null,
  editable: false,
  runtime: true,
}))

/** 全部工具（代码声明在前，runtime 工具附在最后） */
export const TOOL_ADMIN_SPECS: readonly ToolAdminSpec[] = [...MANIFEST_SPECS, ...RUNTIME_SPECS]

const BY_KEY = new Map(TOOL_ADMIN_SPECS.map((spec) => [spec.key, spec]))

/** 按 key 取元数据（未知 key 返回 undefined，由 service 翻成 3407） */
export const findToolAdminSpec = (toolKey: string): ToolAdminSpec | undefined => BY_KEY.get(toolKey)

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
