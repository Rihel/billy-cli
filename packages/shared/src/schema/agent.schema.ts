import { z } from 'zod'
import { BasePaginateSchema } from './base.schema'

/**
 * AI Agent 契约（前后端 + SDK 共用）。
 *
 * 当前只有**装配层**的只读契约：能力状态与 agent 清单。
 *
 * **对话 / 会话契约刻意还没有定义**：会话要落库（消息、推理过程）、要有短期与长期记忆、
 * 要有可恢复的运行状态机，这些的字段形状取决于运行时方案（见 `docs/design/ai-agent.md`）。
 * 先摆一套"无状态一问一答"的契约会误导调用方以为消息已被保存，故留空待设计。
 */

/** 单个 agent 的对外画像（前端 agent 选择器据此渲染） */
export const AgentInfoSchema = z.object({
  /** agent key：稳定的对外标识（加 agent 时声明，前后端与数据库都用它） */
  key: z.string(),
  name: z.string(),
  description: z.string(),
  /** 是否为默认 agent（前端未选择时的落点） */
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
  /** 默认 agent 的 key（请求省略 agentKey 时的落点） */
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

/** 会话（对外模型） */
export const AgentConversationSchema = z.object({
  id: z.string(),
  /** 创建时用的 agent key（会话可换 agent，以每次运行为准） */
  agentKey: z.string(),
  title: z.string(),
  /** 状态：见 ConversationStatus 字典 */
  status: z.string(),
  /** 轮数（一次问答算一轮） */
  turnCount: z.number().int().nonnegative(),
  /** 累计 token（跨轮合计） */
  totalTokens: z.number().int().nonnegative(),
  lastActiveAt: z.union([z.string(), z.date()]),
  createdAt: dateField,
  updatedAt: dateField,
})

export type AgentConversationModel = z.infer<typeof AgentConversationSchema>

/** 创建会话入参（`POST /agent/conversation/create`） */
export const AgentConversationCreateSchema = z.object({
  /** 用哪个 agent；省略用默认 agent */
  agentKey: z.string().min(1).max(64).optional(),
  /** 会话标题；省略则由首条消息生成 */
  title: z.string().max(200).optional(),
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

/** 系统指令查询入参（`POST /agent/instructions`；省略 agentKey 用默认 agent） */
export const AgentInstructionsSchema = z.object({
  agentKey: z.string().min(1).max(64).optional(),
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

/** 一轮问答入参（`POST /agent/chat`，非流式；流式见后续 `/agent/chat/stream`） */
export const AgentChatSchema = z.object({
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
  /** 本轮用户输入 */
  message: z.string().min(1).max(8000),
})

export type AgentChatDto = z.infer<typeof AgentChatSchema>

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
