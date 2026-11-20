import { z } from 'zod'
import { BaseModelSchema } from './base.schema'

/** 市场条目类型（§6.9） */
export const MarketItemTypeSchema = z.enum(['mcp', 'cli', 'skill'])
export type MarketItemType = z.infer<typeof MarketItemTypeSchema>

/** 归属：mcp 只能是平台资产；cli / skill 归个人 */
export const MarketItemScopeSchema = z.enum(['platform', 'personal'])
export type MarketItemScope = z.infer<typeof MarketItemScopeSchema>

export const MarketItemSchema = BaseModelSchema.extend({
  key: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  category: z.string().nullable(),
  type: MarketItemTypeSchema,
  scope: MarketItemScopeSchema,
  payload: z.record(z.string(), z.unknown()),
  icon: z.string().nullable(),
})
export type MarketItemModel = z.infer<typeof MarketItemSchema>

export const MarketItemListSchema = z.object({
  type: MarketItemTypeSchema.optional(),
  scope: MarketItemScopeSchema.optional(),
})
export type MarketItemListDto = z.infer<typeof MarketItemListSchema>

/** 收录 / 更新一条市场条目（v1 只接受 mcp，scope 固定 platform） */
export const MarketItemSaveSchema = z
  .object({
    key: z.string().min(1).max(64),
    name: z.string().min(1).max(64),
    description: z.string().max(2000).optional(),
    category: z.string().max(32).optional(),
    type: MarketItemTypeSchema,
    payload: z.record(z.string(), z.unknown()).default({}),
    icon: z.string().max(255).optional(),
  })
  .refine((value) => value.type === 'mcp', 'v1 市场只收录 MCP 条目（CLI / 技能随用户端开放）')
export type MarketItemSaveDto = z.infer<typeof MarketItemSaveSchema>

export const MarketItemKeySchema = z.object({ key: z.string().min(1).max(64) })
export type MarketItemKeyDto = z.infer<typeof MarketItemKeySchema>
