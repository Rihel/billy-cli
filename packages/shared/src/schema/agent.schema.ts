import { z } from 'zod'
import { BasePaginateSchema } from './base.schema'

/**
 * AI Agent 数据结构（前后端 + SDK 共用）。
 *
 * 当前只有**装配层**的只读数据结构：能力状态与 agent 清单。
 *
 * **对话 / 会话的约定刻意还没有定义**：会话要落库（消息、推理过程）、要有短期与长期记忆、
 * 要有可恢复的运行状态机，这些的字段形状取决于运行时方案（见 `docs/design/ai-agent.md`）。
 * 先摆一套"无状态一问一答"的数据结构会误导调用方以为消息已被保存，故留空待设计。
 */

/**
 * 对话附件的**大小上限**（字节）：前端拦截与后端校验用同一个数。
 *
 * 为什么是 2MB：服务端请求体上限就是 2mb（`main.ts` 的 `useBodyParser`），而附件走
 * 「预签名直传对象存储 + 只传存储 key」这条路，请求体里没有文件内容 —— 这个上限约束的是
 * **单份文件本身**，模型侧再把它转成 data URL 送进去。
 */
export const CHAT_ATTACHMENT_MAX_BYTES = 2 * 1024 * 1024

/** 一轮问答最多带几个附件 */
export const CHAT_ATTACHMENT_MAX_COUNT = 3

/**
 * 单条用户消息（`message`）的**字符上限**。
 *
 * 前端在发送前用它判断"要不要把长文本转成附件"，后端 zod 用同一个数做权威校验 ——
 * 两处写死不同数字，就是"前端放过、服务端 400"的经典漂移（`message不能超过8000个字符`）。
 */
export const CHAT_MESSAGE_MAX_CHARS = 8000

/**
 * 文本类附件**内联给模型**的字符上限（超过截断，并在内容里写明截了多少）。
 *
 * 服务端用它实际截断；前端用它提示"超长内容模型读不全"—— 同一个数只写一处，
 * 否则两边口径漂移，用户会以为整份长文都喂进去了。
 */
export const CHAT_ATTACHMENT_TEXT_INLINE_LIMIT = 20_000

/**
 * 一轮问答的附件（已上传到对象存储的那一份）。
 *
 * 只带**存储 key 与元数据**，不带文件内容：请求体因此与文件大小无关（不会撑爆 2mb 上限），
 * 时间线落库也只存这份元数据，回看历史时按需再解析可访问地址。
 */
export const ChatAttachmentSchema = z.object({
  /** 对象存储 key（前端经 `POST /storage/get-presigned-url` 直传后拿到） */
  key: z.string().min(1).max(512),
  /** 原始文件名（展示与提示词里都用它） */
  filename: z.string().min(1).max(255),
  /** IANA 媒体类型；缺省按 `application/octet-stream` 处理 */
  mediaType: z.string().min(1).max(128),
  /** 字节数（服务端据此复核上限，不信前端自述也得有个对照） */
  bytes: z.number().int().nonnegative().max(CHAT_ATTACHMENT_MAX_BYTES),
})

export type ChatAttachmentModel = z.infer<typeof ChatAttachmentSchema>

/** 单个 agent 的对外画像（前端 agent 选择器据此渲染） */
export const AgentInfoSchema = z.object({
  /** agent key：稳定的对外标识（加 agent 时声明，前后端与数据库都用它） */
  key: z.string(),
  name: z.string(),
  description: z.string(),
  /** 是否为默认 agent（前端未选择时用它） */
  isDefault: z.boolean(),
  /** 该 agent 已装配的技能名（排查"模型没按技能回答"时的第一眼依据） */
  skills: z.array(z.string()),
  /**
   * 是否具备**创建子 agent** 的能力（= 工具面里有委派类工具）。
   *
   * 子 agent 由主 agent 在运行期**调用工具动态创建**（不是装配期声明的固定清单），
   * 因此这里只有能力开关，没有"子 agent 名单"——见 docs/design/ai-agent.md §3.14。
   */
  canSpawnSubAgents: z.boolean(),
})

export type AgentInfoModel = z.infer<typeof AgentInfoSchema>

/** agent 清单（`POST /agent/list`） */
export const AgentListSchema = z.object({
  agents: z.array(AgentInfoSchema),
  /** 默认 agent 的 key（请求省略 agentKey 时用它） */
  defaultAgentKey: z.string(),
})

export type AgentListModel = z.infer<typeof AgentListSchema>

/** Agent 能力状态（`POST /agent/status`：前端据此决定展示对话区还是配置指引） */
export const AgentStatusSchema = z.object({
  /**
   * AI 能力是否可用 = **库里有没有"供应商启用 + 模型启用"的模型**（§4.9）。
   *
   * 注意语义变了：过去看环境变量配没配，现在只看**后台有没有配模型** ——
   * 这正是"agent 只能使用配的模型"的对外体现。
   */
  available: z.boolean(),
  /** 默认模型的标识（`<providerSlug>/<modelKey>`；库空时为 null） */
  model: z.string().nullable(),
  /** 可选用模型数量 */
  modelCount: z.number().int().nonnegative(),
  /** 已注册的 agent 数量 */
  agentCount: z.number().int().nonnegative(),
})

export type AgentStatusModel = z.infer<typeof AgentStatusSchema>

// ─────────────────────────── 会话 / 运行 / 时间线（读写链路） ───────────────────────────
// 命名口径：**轮（turn）** = 一次问答；**步（step）** = 一轮里的一次模型调用。
// 详见 docs/design/ai-agent.md 的术语表。

/** 日期时间字段：接受 string 或 Date（与 base.schema 的约定一致，本文件自持一份以免导出内部常量） */
const dateField = z.union([z.string(), z.date()]).optional()

/** 文件来源：用户上传 / AI 生成（与 `FileSource` 字典的值一致） */
export const AgentFileSourceSchema = z.enum(['user', 'ai'])
export type AgentFileSourceValue = z.infer<typeof AgentFileSourceSchema>

/** 会话文件（`ai_files` 一行的对外投影；不含字节） */
export const AgentFileModelSchema = z.object({
  /** 会话内逻辑路径：入站 uploads/{md5}{ext}，AI {fileKey} */
  path: z.string(),
  source: AgentFileSourceSchema,
  /** 展示名：入站原始文件名，AI 取 path 最后一段 */
  filename: z.string(),
  /** 对象存储完整 key（前端预览 / 下载用） */
  key: z.string(),
  bytes: z.number().int().nonnegative(),
  mediaType: z.string(),
  /** AI 产出必有；入站可空（key 自带 md5） */
  sha256: z.string().nullable(),
  createdAt: dateField,
  updatedAt: dateField,
})
export type AgentFileModel = z.infer<typeof AgentFileModelSchema>

/** 文件树节点（目录隐式生成；文件节点带 `file`） */
export interface AgentFileNode {
  name: string
  path: string
  type: 'dir' | 'file'
  children?: AgentFileNode[]
  file?: AgentFileModel
}

export const AgentFileNodeSchema: z.ZodType<AgentFileNode> = z.lazy(() =>
  z.object({
    name: z.string(),
    path: z.string(),
    type: z.enum(['dir', 'file']),
    children: z.array(AgentFileNodeSchema).optional(),
    file: AgentFileModelSchema.optional(),
  }),
)

/**
 * AI 文件管理（后台独立页 `POST /agent/file/admin/list`）的筛选条件。
 *
 * 时间范围按文件 `created_at`（创建时间）过滤，from / to 都是闭区间日期。
 */
export const AgentFileAdminQuerySchema = z.object({
  keyword: z.string().trim().max(100).optional(),
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
})
export type AgentFileAdminQueryDto = z.infer<typeof AgentFileAdminQuerySchema>

/** 全量文件列表（管理员，含所属会话标题） */
export const AgentFileAdminListSchema = BasePaginateSchema.extend({
  ...AgentFileAdminQuerySchema.shape,
  sortBy: z.enum(['size', 'createdAt', 'updatedAt']).optional().default('createdAt'),
  sortOrder: z.enum(['asc', 'desc']).optional().default('desc'),
})
export type AgentFileAdminListDto = z.infer<typeof AgentFileAdminListSchema>

/** 文件总量统计（管理员；与列表共用 keyword / 时间范围筛选） */
export const AgentFileAdminStatsSchema = AgentFileAdminQuerySchema
export type AgentFileAdminStatsDto = z.infer<typeof AgentFileAdminStatsSchema>

/** 工作区文件生成临时对象存储链接（前端直接 fetch OSS，不经过后端下载转发） */
export const AgentFileWorkspaceLinkSchema = z.object({
  conversationId: z.string().min(1).max(32),
  path: z.string().min(1).max(1024),
  /** true = 带 attachment disposition（下载）；false / 省略 = inline（预览） */
  download: z.boolean().optional(),
})
export type AgentFileWorkspaceLinkDto = z.infer<typeof AgentFileWorkspaceLinkSchema>

export const AgentFileLinkModelSchema = z.object({
  url: z.string(),
  mediaType: z.string(),
  filename: z.string(),
  bytes: z.number().int().nonnegative(),
})
export type AgentFileLinkModel = z.infer<typeof AgentFileLinkModelSchema>

/** 管理员预览：按文件 id 取文本内容（任意会话） */
/** 管理员预览：按文件 id 取文本内容（任意会话） */
export const AgentFileAdminPreviewSchema = z.object({
  fileId: z.string().min(1).max(32),
})
export type AgentFileAdminPreviewDto = z.infer<typeof AgentFileAdminPreviewSchema>

/** 全量文件列表的一行 */
export const AgentFileAdminItemSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  conversationTitle: z.string(),
  filename: z.string(),
  path: z.string(),
  key: z.string(),
  source: AgentFileSourceSchema,
  mediaType: z.string(),
  bytes: z.number().int().nonnegative(),
  createdAt: z.union([z.string(), z.date()]),
  updatedAt: z.union([z.string(), z.date()]),
})
export type AgentFileAdminItem = z.infer<typeof AgentFileAdminItemSchema>

export const AgentFileAdminListModelSchema = z.object({
  items: z.array(AgentFileAdminItemSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  size: z.number().int().positive(),
})
export type AgentFileAdminListModel = z.infer<typeof AgentFileAdminListModelSchema>

export const AgentFileAdminStatsModelSchema = z.object({
  count: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
  userCount: z.number().int().nonnegative(),
  userBytes: z.number().int().nonnegative(),
  aiCount: z.number().int().nonnegative(),
  aiBytes: z.number().int().nonnegative(),
  conversationCount: z.number().int().nonnegative(),
})
export type AgentFileAdminStatsModel = z.infer<typeof AgentFileAdminStatsModelSchema>

/** 工作区文件（`workspace-files` / HTTP 列表的一行，不含内容） */
export const AgentWorkspaceFileSchema = z.object({
  path: z.string(),
  bytes: z.number().int().nonnegative(),
  mtime: z.string(),
})
export type AgentWorkspaceFile = z.infer<typeof AgentWorkspaceFileSchema>

/** 工作区扁平清单 */
export const AgentWorkspaceListSchema = z.object({
  items: z.array(AgentWorkspaceFileSchema),
  total: z.number().int().nonnegative(),
  truncated: z.boolean(),
})
export type AgentWorkspaceListModel = z.infer<typeof AgentWorkspaceListSchema>

/** 文本预览结果（会话文件 / 工作区共用） */
export const AgentFilePreviewSchema = z.object({
  text: z.string(),
  mediaType: z.string(),
  truncated: z.boolean(),
})
export type AgentFilePreviewModel = z.infer<typeof AgentFilePreviewSchema>

/** 会话（对外模型） */
/**
 * 会话的**文件权限**：只读 / 可写（与 kits 的 `WORKSPACE_FILE_ACCESS` 同值）。
 *
 * 只影响沙箱内能不能写工作区；"要不要沙箱"是部署配置，用户选不到（web 产品的安全底线）。
 */
export const AgentFileAccessSchema = z.enum(['read-only', 'workspace-write'])
export type AgentFileAccess = z.infer<typeof AgentFileAccessSchema>

export const AgentConversationSchema = z.object({
  id: z.string(),
  /** 创建时用的 agent key（会话可换 agent，以每次运行为准） */
  agentKey: z.string(),
  title: z.string(),
  /** 状态：见 ConversationStatus 字典 */
  status: z.string(),
  /**
   * 这个会话的**文件权限**：`workspace-write`（默认）/ `read-only`。
   *
   * 会话级设置（会话页顶部切换），随每一轮进运行时信封；**不能借此逃出沙箱**。
   */
  fileAccess: AgentFileAccessSchema,
  /** 轮数（一次问答算一轮） */
  turnCount: z.number().int().nonnegative(),
  /**
   * 这个会话**现在有正在跑的一轮**（根 run 处于 pending / running）。
   *
   * 由 `conversation/list` 与 `conversation/detail` 查询时计算：
   * `create` / `rename` 这类写操作不回这个字段（一律 false），前端以列表/详情为准。
   */
  running: z.boolean(),
  /** 累计 token（跨轮合计） */
  totalTokens: z.number().int().nonnegative(),
  lastActiveAt: z.union([z.string(), z.date()]),
  createdAt: dateField,
  updatedAt: dateField,
  /**
   * 本会话的文件树（用户上传 + AI 提交）。只在 `conversation/detail` 返回；
   * `conversation/list` 不返回，避免列表页把每棵树都拉出来。
   */
  aiFiles: z.array(AgentFileNodeSchema).optional(),
})

export type AgentConversationModel = z.infer<typeof AgentConversationSchema>

/** 创建会话入参（`POST /agent/conversation/create`） */
export const AgentConversationCreateSchema = z.object({
  /** 用哪个 agent；省略用默认 agent */
  agentKey: z.string().min(1).max(64).optional(),
  /** 会话标题；省略则由首条消息生成 */
  title: z.string().max(200).optional(),
  /** 文件权限；省略用默认值（可写） */
  fileAccess: AgentFileAccessSchema.optional(),
})

export type AgentConversationCreateDto = z.infer<typeof AgentConversationCreateSchema>

/** 会话列表入参（`POST /agent/conversation/list`） */
export const AgentConversationListSchema = BasePaginateSchema.extend({
  /** 是否包含已软删的会话（默认 false；审计视角用） */
  includeDeleted: z.boolean().optional().default(false),
})

export type AgentConversationListDto = z.infer<typeof AgentConversationListSchema>

/** 会话 id 入参（detail / remove 共用） */
export const AgentConversationIdSchema = z.object({
  conversationId: z.string().min(1).max(32),
})

export type AgentConversationIdDto = z.infer<typeof AgentConversationIdSchema>

/**
 * 会话重命名入参（`POST /agent/conversation/rename`）—— 用户手动改名。
 *
 * 长度上限 30，与"首轮自动起名"（≤10 字，见 `runtime/title.service.ts`）是两个口径：
 * 自动名短是为了在侧栏一行放得下，手动名给宽一点（用户想怎么写就怎么写）。
 * `.trim()` 写在 `.min(1)` 之前：全是空格的名字拦在边界，
 * 否则库里会出现"看不见的标题"（列表里那一行空白，谁都不知道发生了什么）。
 */
export const AgentConversationRenameSchema = AgentConversationIdSchema.extend({
  title: z.string().trim().min(1).max(30),
})

export type AgentConversationRenameDto = z.infer<typeof AgentConversationRenameSchema>

/** 切换会话文件权限（`POST /agent/conversation/file-access`） */
export const AgentConversationFileAccessSchema = AgentConversationIdSchema.extend({
  fileAccess: AgentFileAccessSchema,
})

export type AgentConversationFileAccessDto = z.infer<typeof AgentConversationFileAccessSchema>

/**
 * 系统指令查询入参（`POST /agent/instructions`）。
 *
 * 两种口径：
 * - 给了 `conversationId` → 回**那个会话实际用过的系统指令**（渲染后的快照，含首轮运行环境）；
 * - 只给 `agentKey` / 都不给 → 回**当前装配期渲染好的静态指令**（还没跑过任何一轮时是唯一可回的东西）。
 */
export const AgentInstructionsSchema = z.object({
  agentKey: z.string().min(1).max(64).optional(),
  /** 会话 id：给了就优先回该会话的系统指令快照 */
  conversationId: z.string().min(1).max(32).optional(),
})

export type AgentInstructionsDto = z.infer<typeof AgentInstructionsSchema>

/**
 * 系统指令（`POST /agent/instructions`）。
 *
 * 返回**装配期渲染好的当前定义**（`AgentDefinition.instructions`）：可用工具、通用约定、
 * 角色约定全在里面，等于"这个 agent 现在被怎么要求"的原文。
 * 与某一次运行的差异（会话首轮末尾还会追加「运行环境」片段，§3.15.4）是**按轮拼上去的**，
 * 不在这份静态指令里 —— 接口口径就是"静态系统指令"。
 */
export const AgentInstructionsModelSchema = z.object({
  agentKey: z.string(),
  name: z.string(),
  description: z.string(),
  instructions: z.string(),
  /**
   * 这份指令的来源：
   * - `conversation`：会话时间线里的**渲染后快照**（真正送进模型的那份，可能含首轮运行环境）；
   * - `definition`：装配期的**静态定义**（该会话还没跑过任何一轮，或历史会话早于"落快照"这一步）。
   */
  source: z.enum(['conversation', 'definition']),
  /** 快照的落库时间（`source='definition'` 时为 null） */
  recordedAt: z.union([z.string(), z.date()]).nullable(),
})

export type AgentInstructionsModel = z.infer<typeof AgentInstructionsModelSchema>

/** 时间线查询入参（`POST /agent/timeline/list`） */
export const AgentTimelineListSchema = BasePaginateSchema.extend({
  conversationId: z.string().min(1).max(32),
  /** 只看某一轮；省略看整个会话 */
  runId: z.string().min(1).max(32).optional(),
})

export type AgentTimelineListDto = z.infer<typeof AgentTimelineListSchema>

/** 时间线事件（对外模型，一行一个 part / 事件） */
export const AgentTimelineItemSchema = z.object({
  id: z.string(),
  seq: z.number().int(),
  conversationId: z.string(),
  runId: z.string().nullable(),
  messageId: z.string(),
  /** 第几次尝试（崩溃恢复重跑时 > 1） */
  attempt: z.number().int().positive(),
  role: z.string(),
  /** 事件类型：见 TimelineKind 字典 */
  kind: z.string(),
  state: z.string().nullable(),
  toolKey: z.string().nullable(),
  toolCallId: z.string().nullable(),
  startedAt: dateField,
  finishedAt: dateField,
  durationMs: z.number().int().nullable(),
  usage: z.record(z.string(), z.unknown()).nullable(),
  /** **完整原文**（工具入参出参、摘要正文等，一律不裁剪） */
  payload: z.record(z.string(), z.unknown()).nullable(),
})

export type AgentTimelineItemModel = z.infer<typeof AgentTimelineItemSchema>

/**
 * 用户消息事件（`kind='text'` 且 `role='user'`）的载荷形状。
 *
 * 落库时刻的原始形状是 `{ text, attachments? }`；这里给它一个**可选**的类型收口，
 * 让前后端对同一份形状有共同说法（前端重建历史、后台审计页都读它）。
 * 没有附件的历史事件保持 `{ text }` 的老形状，所以 `attachments` 是可选的。
 */
export const AgentUserMessagePayloadSchema = z.object({
  text: z.string(),
  attachments: z.array(ChatAttachmentSchema).optional(),
})

export type AgentUserMessagePayloadModel = z.infer<typeof AgentUserMessagePayloadSchema>

/** 运行（一轮问答的记录）对外模型 */
export const AgentRunSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  /**
   * 父 run（子 agent 才有；`null` = 根 run = 一轮问答）。
   *
   * 子 agent 的明细与根 run 落在同一张表、同一个会话里，靠这一列分出父子树。
   */
  parentRunId: z.string().nullable(),
  /** 深度：根 0、子 agent 1（当前工具面保证不超过 1，配置位留给将来） */
  depth: z.number().int().nonnegative(),
  /** 子 run 专用：父那次工具调用的 id（幂等键的一半，重放时同一 id 只生效一次） */
  toolCallId: z.string().nullable(),
  agentKey: z.string(),
  /** 发起人（= 登录用户 id；列表页按人筛选时用） */
  triggeredBy: z.string().nullable(),
  /** 发起该轮的 HTTP X-Request-Id（把审计记录与日志 / 告警串起来，排障第一步） */
  requestId: z.string().nullable(),
  /** 见 RunStatus 字典 */
  status: z.string(),
  recoveryCount: z.number().int().nonnegative(),
  errorCode: z.string().nullable(),
  errorStage: z.string().nullable(),
  errorMessage: z.string().nullable(),
  startedAt: dateField,
  finishedAt: dateField,
  durationMs: z.number().int().nullable(),
  firstTokenMs: z.number().int().nullable(),
  stepCount: z.number().int().nonnegative(),
  toolCallCount: z.number().int().nonnegative(),
  usage: z.record(z.string(), z.unknown()).nullable(),
})

export type AgentRunModel = z.infer<typeof AgentRunSchema>

/** 运行详情入参（`POST /agent/run/detail`） */
export const AgentRunIdSchema = z.object({
  runId: z.string().min(1).max(32),
})

export type AgentRunIdDto = z.infer<typeof AgentRunIdSchema>

/**
 * 运行详情（审计 / 复盘用）：在列表模型之上补三样**只在详情里要**的东西。
 *
 * - `requestSnapshot`：送给模型的输入侧证据（模型 / 参数 / 工具与技能清单 / 上下文取舍；
 *   子 agent 还有主 agent 现写的提示词与任务）—— 列表里不带它是为了不让每行都驮一坨 JSON；
 * - `errorDetail`：上游错误原文（**全量**，仅密钥掩码），排障要看原话；
 * - `children`：子 agent 的 run（父子树，前端据此展开嵌套）。
 */
export const AgentRunDetailSchema = AgentRunSchema.extend({
  requestSnapshot: z.record(z.string(), z.unknown()).nullable(),
  errorDetail: z.record(z.string(), z.unknown()).nullable(),
  children: z.array(AgentRunSchema),
})

export type AgentRunDetailModel = z.infer<typeof AgentRunDetailSchema>

/** 运行列表入参（`POST /agent/run/list`：审计 / 复盘页按会话拉全部运行，**含子 agent**） */
export const AgentRunListSchema = BasePaginateSchema.extend({
  conversationId: z.string().min(1).max(32),
})

export type AgentRunListDto = z.infer<typeof AgentRunListSchema>

/**
 * 控制台「AI 用量」查询（`POST /agent/usage/summary`，管理员）。
 *
 * 只统计**根 run**（`parent_run_id IS NULL`）：子 agent 的消耗已经汇总进父 run，
 * 再按行加总会重复计费。
 */
export const AgentUsageSummaryQuerySchema = z.object({
  /** 看最近多少天（含今天），默认 7，最多 90 */
  days: z.number().int().min(1).max(90).optional().default(7),
})

export type AgentUsageSummaryQueryDto = z.infer<typeof AgentUsageSummaryQuerySchema>

/** 手动回填 AI 用量日表（管理员） */
export const AgentUsageRangeSchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
})
export type AgentUsageRangeDto = z.infer<typeof AgentUsageRangeSchema>

/** 每日用量（日期按数据库时区，格式 YYYY-MM-DD） */
export const AgentUsageDailySchema = z.object({
  date: z.string(),
  runs: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
})

export type AgentUsageDailyModel = z.infer<typeof AgentUsageDailySchema>

/** 按模型 / agent 聚合的一行 */
export const AgentUsageBucketSchema = z.object({
  key: z.string(),
  runs: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
})

export type AgentUsageBucketModel = z.infer<typeof AgentUsageBucketSchema>

/** 区间汇总 */
export const AgentUsageTotalsSchema = z.object({
  runs: z.number().int().nonnegative(),
  succeeded: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  canceled: z.number().int().nonnegative(),
  interrupted: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
  reasoningTokens: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative(),
  avgDurationMs: z.number().int().nonnegative(),
  avgFirstTokenMs: z.number().int().nonnegative(),
  steps: z.number().int().nonnegative(),
  toolCalls: z.number().int().nonnegative(),
})

export type AgentUsageTotalsModel = z.infer<typeof AgentUsageTotalsSchema>

/** 控制台「AI 用量」返回 */
export const AgentUsageSummaryModelSchema = z.object({
  days: z.number().int().positive(),
  /** 区间起点（ISO 字符串，含当天 00:00） */
  since: z.string(),
  totals: AgentUsageTotalsSchema,
  daily: z.array(AgentUsageDailySchema),
  byAgent: z.array(AgentUsageBucketSchema),
  byModel: z.array(AgentUsageBucketSchema),
})

export type AgentUsageSummaryModel = z.infer<typeof AgentUsageSummaryModelSchema>

/** 一轮问答入参（`POST /agent/chat`，非流式；流式见后续 `/agent/chat/stream`） */
export const AgentChatSchema = z
  .object({
    /** 会话 id；省略则新建会话 */
    conversationId: z.string().min(1).max(32).optional(),
    /** 新建会话时用哪个 agent；省略用默认 agent */
    agentKey: z.string().min(1).max(64).optional(),
    /**
     * 本轮用哪个模型（`ai_models.id`）；省略 = 用服务端的默认模型。
     *
     * **只能选"供应商启用 + 模型启用"的**（§4.9）：传了不存在 / 已禁用的 id 直接 3402 / 3404，
     * 不做"静默回落" —— 用户明确选了 A 却跑了 B 是最坏的体验。
     */
    modelId: z.string().min(1).max(32).optional(),
    /**
     * 本会话的文件权限（`read-only` / `workspace-write`）。
     *
     * 新会话据此建；已有会话传了就以它为准（顺手把会话上的值同步成它）。
     * 省略 = 沿用会话上已存的（新会话则是默认 `workspace-write`）。
     */
    fileAccess: AgentFileAccessSchema.optional(),
    /**
     * 本轮用户输入。
     *
     * 允许为空串：**可以只发附件不说话**（拖一张图上来问"这是什么"时，文字本来就是空的），
     * 但「文字与附件不能同时为空」由下面的 `superRefine` 兜住 —— 空轮次没有意义，
     * 让它到服务端才发现是白跑一轮。
     */
    message: z.string().max(CHAT_MESSAGE_MAX_CHARS),
    /** 本轮附件（最多 {@link CHAT_ATTACHMENT_MAX_COUNT} 个，每个 ≤ {@link CHAT_ATTACHMENT_MAX_BYTES}） */
    attachments: z.array(ChatAttachmentSchema).max(CHAT_ATTACHMENT_MAX_COUNT).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.message.trim().length === 0 && (value.attachments?.length ?? 0) === 0) {
      ctx.addIssue({
        code: 'custom',
        message: '文字与附件不能同时为空',
        path: ['message'],
      })
    }
  })

export type AgentChatDto = z.infer<typeof AgentChatSchema>

/**
 * 工具向用户提问的答案。
 *
 * `value`：单选 / 问答是字符串；多选是字符串数组（选项 label）。
 */
export const AgentQuestionAnswerSchema = z.object({
  id: z.string().min(1).max(48),
  value: z.union([z.string().max(2000), z.array(z.string().max(200)).max(8)]),
})

/**
 * 回答挂起中的一轮（`POST /agent/chat/resume`）。
 *
 * 两种合法入参：
 * - 正常提交：`answers` 至少一条；
 * - **取消整组回答**：`cancelled: true`，不带 `answers`（Mastra 的 `suspend()` 没有
 *   `declineToolCall()` 那种独立入口，官方做法就是带着"取消"这个 resumeData 续跑，
 *   工具据此把"用户取消"转成模型可读的结论并继续）。
 */
export const AgentChatResumeSchema = z
  .object({
    /** 挂起的那一轮（不是会话 id） */
    runId: z.string().min(1).max(64),
    /** 一次回答多个问题；取消时可为空 */
    answers: z.array(AgentQuestionAnswerSchema).max(8).optional(),
    /** 用户放弃回答这一整组问题（工具收到后继续处理，不再次追问） */
    cancelled: z.boolean().optional(),
    /** 同时有多个挂起工具时，指定回答哪一个（省略 = Mastra 自己选） */
    toolCallId: z.string().min(1).max(128).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.cancelled === true) return
    if (!value.answers || value.answers.length === 0) {
      ctx.addIssue({
        code: 'custom',
        message: '提交回答时 answers 至少一条；不回答请传 cancelled: true',
        path: ['answers'],
      })
    }
  })

export type AgentQuestionAnswer = z.infer<typeof AgentQuestionAnswerSchema>
export type AgentChatResumeDto = z.infer<typeof AgentChatResumeSchema>

/** 一轮问答结果（非流式） */
export const AgentChatResultSchema = z.object({
  conversationId: z.string(),
  runId: z.string(),
  /** 见 RunStatus 字典 */
  status: z.string(),
  /** 助手回复正文（多轮工具调用后的最终文本） */
  content: z.string(),
  /** 本轮步数（模型调用次数） */
  stepCount: z.number().int().nonnegative(),
  /** 本轮工具调用次数 */
  toolCallCount: z.number().int().nonnegative(),
  /** 本轮消耗汇总（真实值来自 provider；字段可能为 null） */
  usage: z.record(z.string(), z.unknown()).nullable(),
  /** 本轮耗时（ms） */
  durationMs: z.number().int().nullable(),
})

export type AgentChatResultModel = z.infer<typeof AgentChatResultSchema>

/** 停止入参（`POST /agent/run/stop`） */
export const AgentRunStopSchema = z.object({
  runId: z.string().min(1).max(32),
})

export type AgentRunStopDto = z.infer<typeof AgentRunStopSchema>

/** 停止结果（`POST /agent/run/stop`） */
export const AgentRunStopResultSchema = z.object({
  /** 是否已发出停止指令（**幂等**：重复停止也返回 true） */
  stopped: z.boolean(),
  /**
   * 停止指令从哪条路生效：
   * - `local`：这一轮就跑在本副本上，直接 abort；
   * - `broadcast`：本副本没有它的执行权，经 Redis 广播给持有者（见设计文档 §3.10）。
   */
  injected: z.enum(['local', 'broadcast']),
})

export type AgentRunStopResultModel = z.infer<typeof AgentRunStopResultSchema>
