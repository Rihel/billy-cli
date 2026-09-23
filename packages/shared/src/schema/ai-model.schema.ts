import { z } from 'zod'
import { AiModelSource, AiProviderKind } from '../dicts/ai-model.dict'

/**
 * AI 模型模块契约：**与两张表一一对应的对外模型**（供应商 / 模型）。
 *
 * 本轮只落地**数据表 + 对外模型**（双轨同步，见 skill `define-data-structure`）；
 * CRUD / 同步接口的 DTO 在做模块时再加（设计已定，见 `docs/design/ai-agent.md` §4.8）。
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
