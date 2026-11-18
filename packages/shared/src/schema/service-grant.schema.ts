import { z } from 'zod'
import { BaseModelSchema } from './base.schema'

/** 服务级授权（当前只有 admin；后续扩展 user / role） */
export const ServiceGrantSchema = BaseModelSchema.extend({
  principalType: z.enum(['admin']),
  principalId: z.string(),
  service: z.string(),
  grantedBy: z.string().nullable(),
})
export type ServiceGrantModel = z.infer<typeof ServiceGrantSchema>

/** 查询：返回全部授权行（页面一次拉全） */
export const ServiceGrantListSchema = z.object({})
export type ServiceGrantListDto = z.infer<typeof ServiceGrantListSchema>

/** 覆盖式设置某个管理员的可用服务 */
export const ServiceGrantSetSchema = z.object({
  adminId: z.string().min(1),
  services: z.array(z.string().min(1)).max(200),
})
export type ServiceGrantSetDto = z.infer<typeof ServiceGrantSetSchema>
