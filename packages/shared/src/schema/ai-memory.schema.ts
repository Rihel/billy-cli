import { z } from 'zod'
import { AiMemoryKind, AiMemorySource } from '../dicts/ai-memory.dict'
import { BaseModelSchema, BasePaginateSchema } from './base.schema'

/**
 * 长期记忆的数据结构（`/ai-memory/*`，后台管理员鉴权）—— 设计 `docs/design/ai-memory.md` §5。
 *
 * 三条口径：
 * - 记忆按**用户**归属（可选的 `agentKey` 只是收窄范围，不改变归属）；
 * - `memKey` 是稳定的去重标识（agent 写入时同一 key 走 upsert），可为空；
 * - 内容有硬上限，超限在**写入时**就拒绝，不靠注入时截断。
 */

/** 单条内容上限（字符；中文按 1 字符计） */
export const MEMORY_CONTENT_MAX = 500
/** 每用户条数上限 */
export const MEMORY_MAX_PER_USER = 200
/** 每轮最多注入条数 */
export const MEMORY_INJECT_MAX = 20
/** 每轮注入的 token 上限（估算值） */
export const MEMORY_INJECT_MAX_TOKENS = 800
/** Redis thread 清理阈值（天） */
export const MEMORY_THREAD_TTL_DAYS = 30

/** 记忆类型取值（字典是唯一事实源） */
export const AiMemoryKindField = z.enum(AiMemoryKind.values as unknown as [string, ...string[]])

/** 记忆来源取值 */
export const AiMemorySourceField = z.enum(AiMemorySource.values as unknown as [string, ...string[]])

/** 记忆（对外模型） */
const AiMemoryFields = z.object({
  /** 归属用户（逻辑引用，无外键） */
  userId: z.string(),
  /** 收窄到某个 agent；`null` = 该用户所有 agent 共享 */
  agentKey: z.string().nullable().optional(),
  /** 类型，见 `AiMemoryKind` 字典 */
  kind: AiMemoryKindField,
  /** 稳定标识（有值时同一用户 + agent + key 走 upsert） */
  memKey: z.string().nullable().optional(),
  /** 记忆正文 */
  content: z.string(),
  /** 来源，见 `AiMemorySource` 字典 */
  source: AiMemorySourceField,
  /** 每轮必带 */
  pinned: z.boolean().default(false),
  /** 停用即不注入 */
  enabled: z.boolean().default(true),
  /** 被注入次数（P1 起累计） */
  useCount: z.number().int().nonnegative().default(0),
  /** 最后一次被注入的时间 */
  lastUsedAt: z.union([z.string(), z.date()]).nullable().optional(),
  /** 到期时间：过了就不再注入（不物理删） */
  expiresAt: z.union([z.string(), z.date()]).nullable().optional(),
  /** 扩展字段 */
  metadata: z.record(z.string(), z.unknown()).nullable().optional(),
})

export const AiMemorySchema = z.intersection(BaseModelSchema, AiMemoryFields)
export type AiMemoryModel = z.infer<typeof AiMemorySchema>

/** 后台列表（分页 + 归属 / 类型 / 来源 / 启停 / 关键字筛选） */
export const AiMemoryListSchema = BasePaginateSchema.extend({
  userId: z.string().optional(),
  kind: AiMemoryKindField.optional(),
  source: AiMemorySourceField.optional(),
  enabled: z.boolean().optional(),
  keyword: z.string().max(200).optional(),
})
export type AiMemoryListDto = z.infer<typeof AiMemoryListSchema>

/** 后台更新（只改内容 / 类型 / 置顶 / 启停；`memKey` 与归属不可改） */
export const AiMemoryUpdateSchema = z.object({
  id: z.string().min(1),
  content: z.string().min(1).max(MEMORY_CONTENT_MAX).optional(),
  kind: AiMemoryKindField.optional(),
  pinned: z.boolean().optional(),
  enabled: z.boolean().optional(),
})
export type AiMemoryUpdateDto = z.infer<typeof AiMemoryUpdateSchema>

/** 后台删除（软删） */
export const AiMemoryRemoveSchema = z.object({
  id: z.string().min(1),
})
export type AiMemoryRemoveDto = z.infer<typeof AiMemoryRemoveSchema>
