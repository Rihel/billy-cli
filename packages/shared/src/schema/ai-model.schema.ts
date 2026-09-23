import { z } from 'zod'
import { AiModelSource, AiProviderKind } from '../dicts/ai-model.dict'
import { BasePaginateSchema } from './base.schema'

/**
 * AI 模型模块契约：**与两张表一一对应的对外模型**（供应商 / 模型）。
 *
 * 覆盖三层：**表模型**（供应商 / 模型）、**管理台 CRUD 入参**（§4.8.4）、
 * **运行时选模型**（§4.9：一轮对话只能选"已配置且启用"的模型）。
 *
 * 三条与表结构绑定的口径：
 * - **密钥只进不出**：表里存密文 + 提示，对外模型只有 `apiKeyHint` 与 `hasApiKey`，明文永不出现在响应里；
 * - `raw` 是**供应商原始 JSON 的全量留存**（不裁剪）——"模型什么时候消失 / 参数什么时候变了"可复盘；
 * - `model_key` + `provider_id` 是唯一键，也是将来同步时的**幂等 upsert 锚点**。
 */

/** 日期时间字段（与 agent.schema 同一约定：接受 string 或 Date，可选） */
const dateField = z.union([z.string(), z.date()]).optional()

/** 供应商类型（取值来自字典：单一事实源，加一家供应商只改字典） */
export const AiProviderKindField = z.enum(
  AiProviderKind.values as unknown as [string, ...string[]],
)

/** 模型来源（取值来自字典） */
export const AiModelSourceField = z.enum(
  AiModelSource.values as unknown as [string, ...string[]],
)

/** 供应商（对外模型）—— **不含密钥明文** */
export const AiProviderSchema = z.object({
  id: z.string(),
  /** 展示名（唯一）：如「DeepSeek 官方」「自建网关」 */
  name: z.string(),
  /** ASCII 标识（唯一，软删感知）：模型对外标识的前半段 —— `<slug>/<modelKey>`，如 `deepseek/deepseek-chat` */
  slug: z.string(),
  /** 见 `AiProviderKind` 字典（决定用哪家的"列模型"接口拉明细） */
  kind: z.string(),
  /** 接口地址；留空表示用该 kind 的官方默认地址 */
  baseUrl: z.string().nullable(),
  /** 密钥提示（`sk-…abcd`）：给人看"配的是哪一把"，不足以还原密钥 */
  apiKeyHint: z.string().nullable(),
  /** 是否已配置密钥（页面据此决定"能同步"还是"先填密钥"） */
  hasApiKey: z.boolean(),
  enabled: z.boolean(),
  /** 最后一次同步成功时间 */
  lastSyncedAt: dateField,
  /** 最后一次同步失败原因（供应商原文；成功时清空） */
  lastSyncError: z.string().nullable(),
  /** 扩展位（供应商维度的附加信息，如组织 id、代理配置） */
  metadata: z.record(z.string(), z.unknown()).nullable(),
  createdAt: dateField,
  updatedAt: dateField,
})

export type AiProviderModel = z.infer<typeof AiProviderSchema>

/** 模型（对外模型） */
export const AiModelSchema = z.object({
  id: z.string(),
  /** 所属供应商（逻辑引用，无物理外键） */
  providerId: z.string(),
  /** 供应商侧的模型 id（如 `deepseek-chat`；Gemini 的 `models/xxx` 去掉前缀后存这里） */
  modelKey: z.string(),
  displayName: z.string(),
  /** 上下文窗口（同步来的实测值；手工可改，将来供 §3.9 的窗口解析优先使用） */
  contextWindow: z.number().int().positive().nullable(),
  /** 单次输出上限 */
  maxOutputTokens: z.number().int().positive().nullable(),
  /** 能力标记（`tools` / `reasoning` / `vision` / `methods` 等，供应商给什么存什么） */
  capabilities: z.record(z.string(), z.unknown()).nullable(),
  /** 见 `AiModelSource` 字典：同步来的 / 手工补的（手工的同步时不覆盖） */
  source: z.string(),
  /** 是否允许被选用（用户的启停是人的决定，不被同步覆盖） */
  enabled: z.boolean(),
  /** 最后一次在供应商列表里出现的时间（判断"本次未返回"就看它） */
  lastSeenAt: dateField,
  /** 最近一次被同步更新到的时间 */
  syncedAt: dateField,
  /** 供应商返回的原始字段（**全量留存、不裁剪**） */
  raw: z.record(z.string(), z.unknown()).nullable(),
  createdAt: dateField,
  updatedAt: dateField,
})

export type AiModelModel = z.infer<typeof AiModelSchema>

// ─────────────────────── 管理台入参（`/ai-model/*`，全部管理员鉴权） ───────────────────────

/** 供应商分页 */
export const AiProviderListSchema = BasePaginateSchema
export type AiProviderListDto = z.infer<typeof AiProviderListSchema>

/** 新建供应商（`apiKey` 只进不出：服务端加密存，响应只回提示） */
export const AiProviderCreateSchema = z.object({
  name: z.string().min(1).max(64),
  kind: AiProviderKindField,
  /** ASCII 标识（模型对外标识的前半段：`<slug>/<modelKey>`）；留空由 name 生成 */
  slug: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]*$/, '只能是小写字母 / 数字 / 连字符')
    .max(32)
    .optional(),
  /** 留空用该 kind 的官方地址；自建网关 / 代理必须填 */
  baseUrl: z.string().url().max(255).optional(),
  apiKey: z.string().min(1).max(512).optional(),
  enabled: z.boolean().optional().default(true),
})
export type AiProviderCreateDto = z.infer<typeof AiProviderCreateSchema>

/** 供应商 id 入参（detail / remove / sync 共用） */
export const AiProviderIdSchema = z.object({ providerId: z.string().min(1).max(32) })
export type AiProviderIdDto = z.infer<typeof AiProviderIdSchema>

/** 更新供应商（`apiKey` 省略 = 不改；给空串 = 清空密钥） */
export const AiProviderUpdateSchema = z.object({
  providerId: z.string().min(1).max(32),
  name: z.string().min(1).max(64).optional(),
  kind: AiProviderKindField.optional(),
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).max(32).optional(),
  baseUrl: z.string().url().max(255).nullable().optional(),
  apiKey: z.string().max(512).optional(),
  enabled: z.boolean().optional(),
})
export type AiProviderUpdateDto = z.infer<typeof AiProviderUpdateSchema>

/** 连通性测试（支持"未保存先测"：给了 providerId 就用库里已存的密钥） */
export const AiProviderTestSchema = z.object({
  kind: AiProviderKindField,
  baseUrl: z.string().url().max(255).optional(),
  apiKey: z.string().max(512).optional(),
  providerId: z.string().min(1).max(32).optional(),
})
export type AiProviderTestDto = z.infer<typeof AiProviderTestSchema>

export const AiProviderTestResultSchema = z.object({
  ok: z.boolean(),
  /** 拉到的模型数（成功时） */
  modelCount: z.number().int().nonnegative(),
  /** 失败原因（供应商原文，截断到可读长度） */
  error: z.string().nullable(),
  /** 实际请求的地址（排障第一步：确认打到了哪） */
  endpoint: z.string(),
  durationMs: z.number().int().nonnegative(),
})
export type AiProviderTestResultModel = z.infer<typeof AiProviderTestResultSchema>

/** 同步结果（幂等：重复执行结果一致） */
export const AiProviderSyncResultSchema = z.object({
  providerId: z.string(),
  created: z.number().int().nonnegative(),
  updated: z.number().int().nonnegative(),
  unchanged: z.number().int().nonnegative(),
  /** 本次**未返回**的已有模型数（下线或限流；只提示，不自动禁用） */
  missing: z.number().int().nonnegative(),
  /** 供应商本次返回的模型总数 */
  total: z.number().int().nonnegative(),
  syncedAt: dateField,
})
export type AiProviderSyncResultModel = z.infer<typeof AiProviderSyncResultSchema>

/** 模型分页（按供应商 + 可选关键词） */
export const AiModelListSchema = BasePaginateSchema.extend({
  providerId: z.string().min(1).max(32),
  keyword: z.string().max(128).optional(),
})
export type AiModelListDto = z.infer<typeof AiModelListSchema>

/** 手工新增模型（自建网关 `/models` 拉不全、想手填窗口时用；`source='manual'`，同步不覆盖） */
export const AiModelCreateSchema = z.object({
  providerId: z.string().min(1).max(32),
  modelKey: z.string().min(1).max(128),
  displayName: z.string().min(1).max(128).optional(),
  contextWindow: z.number().int().positive().nullable().optional(),
  maxOutputTokens: z.number().int().positive().nullable().optional(),
  enabled: z.boolean().optional().default(true),
})
export type AiModelCreateDto = z.infer<typeof AiModelCreateSchema>

/** 更新模型（启停 / 展示名 / 手工修正窗口） */
export const AiModelUpdateSchema = z.object({
  modelId: z.string().min(1).max(32),
  displayName: z.string().min(1).max(128).optional(),
  contextWindow: z.number().int().positive().nullable().optional(),
  maxOutputTokens: z.number().int().positive().nullable().optional(),
  enabled: z.boolean().optional(),
})
export type AiModelUpdateDto = z.infer<typeof AiModelUpdateSchema>

export const AiModelIdSchema = z.object({ modelId: z.string().min(1).max(32) })
export type AiModelIdDto = z.infer<typeof AiModelIdSchema>

// ─────────────────────── 运行时可选模型（会话页选择器 + 一轮对话指定） ───────────────────────

/**
 * 可选用模型（**只含"供应商启用 + 模型启用"的**，见 §4.9）。
 *
 * `modelRef` 是稳定的对外标识（`<provider.slug>/<modelKey>`，如 `deepseek/deepseek-chat`），
 * 也是 Mastra 认识的形式；`id` 是库里的行 id —— 发请求时**用 id**（不解析字符串，最不容易出错）。
 */
export const AiAvailableModelSchema = z.object({
  id: z.string(),
  /** `<slug>/<modelKey>`：给人看、给日志用，也是 Mastra 的模型标识形态 */
  modelRef: z.string(),
  modelKey: z.string(),
  displayName: z.string(),
  providerId: z.string(),
  providerName: z.string(),
  providerKind: z.string(),
  providerSlug: z.string(),
  contextWindow: z.number().int().positive().nullable(),
  capabilities: z.record(z.string(), z.unknown()).nullable(),
})

export type AiAvailableModelModel = z.infer<typeof AiAvailableModelSchema>

/** 可选模型清单（`POST /ai-model/available`；会话页用它渲染选择器） */
export const AiAvailableModelListSchema = z.object({
  models: z.array(AiAvailableModelSchema),
  /** 未显式选择时的落点（第一个启用的模型；库空时为 null） */
  defaultModelId: z.string().nullable(),
})

export type AiAvailableModelListModel = z.infer<typeof AiAvailableModelListSchema>
