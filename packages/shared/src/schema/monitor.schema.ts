import { z } from 'zod'
import { BaseModel, BasePaginateDto } from './base.schema'

/** 告警通道（对应通知模块 NotifyChannel：lark / email） */
export const AlertChannel = z.enum(['lark', 'email'])
export type AlertChannelType = z.infer<typeof AlertChannel>

/** 规则类型：tech 技术告警（ERROR 级错误 / 未捕获异常）；business 业务告警（错误码 / 关键字匹配） */
export const AlertRuleType = z.enum(['tech', 'business'])
export type AlertRuleTypeValue = z.infer<typeof AlertRuleType>

/** 告警级别：error 优先（warn 也匹配 error 规则） */
export const AlertLevel = z.enum(['warn', 'error'])
export type AlertLevelValue = z.infer<typeof AlertLevel>

const AlertRuleFields = z.object({
  /** 规则名称（唯一，语义化，如「登录失败告警」） */
  name: z.string().min(1).max(50),
  /** 规则类型 */
  type: AlertRuleType.default('tech'),
  /** 匹配错误码（AppErrorCodes 数字码）；空数组 = 匹配该类型全部错误 */
  matchCodes: z.array(z.number().int()).default([]),
  /** 匹配消息关键字（任一命中即匹配）；空数组 = 不限制 */
  keywords: z.array(z.string().min(1)).default([]),
  /** 告警级别（error 级规则同时捕获 warn 错误） */
  level: AlertLevel.default('error'),
  /** 发送通道（至少一个） */
  channels: z.array(AlertChannel).min(1),
  /** 限频窗口秒：同一规则 + 相同内容在窗口内只发一次（防告警风暴） */
  throttleSeconds: z.number().int().min(0).default(60),
  /** 是否启用 */
  enabled: z.boolean().default(true),
})

export const AlertRuleSchema = z.intersection(BaseModel, AlertRuleFields)
export type AlertRuleModel = z.infer<typeof AlertRuleSchema>

export const CreateAlertRuleSchema = AlertRuleFields
export type CreateAlertRuleDto = z.infer<typeof CreateAlertRuleSchema>

export const UpdateAlertRuleSchema = z.intersection(
  z.object({ ruleId: z.string() }),
  AlertRuleFields.partial(),
)
export type UpdateAlertRuleDto = z.infer<typeof UpdateAlertRuleSchema>

export const GetAlertRuleDetailSchema = z.object({ ruleId: z.string() })
export type GetAlertRuleDetailDto = z.infer<typeof GetAlertRuleDetailSchema>

export const RemoveAlertRuleSchema = z.object({ ruleId: z.string() })
export type RemoveAlertRuleDto = z.infer<typeof RemoveAlertRuleSchema>

export const PageQueryAlertRuleSchema = BasePaginateDto.extend({
  keyword: z.string().optional(),
  type: AlertRuleType.optional(),
  enabled: z.boolean().optional(),
  orderBy: z.enum(['updatedAt', 'createdAt']).optional().default('updatedAt'),
  order: z.enum(['asc', 'desc']).optional().default('desc'),
})
export type PageQueryAlertRuleDto = z.infer<typeof PageQueryAlertRuleSchema>

/** 告警发送记录（日志） */
export const AlertLogSchema = z.intersection(
  BaseModel,
  z.object({
    ruleId: z.string().nullable(),
    ruleName: z.string(),
    title: z.string(),
    message: z.string(),
    channel: AlertChannel,
    status: z.enum(['success', 'failed']),
    error: z.string().nullable().optional(),
  }),
)
export type AlertLogModel = z.infer<typeof AlertLogSchema>

export const PageQueryAlertLogSchema = BasePaginateDto.extend({
  ruleId: z.string().optional(),
  channel: AlertChannel.optional(),
  status: z.enum(['success', 'failed']).optional(),
  orderBy: z.enum(['sentAt', 'createdAt']).optional().default('sentAt'),
  order: z.enum(['asc', 'desc']).optional().default('desc'),
})
export type PageQueryAlertLogDto = z.infer<typeof PageQueryAlertLogSchema>

/** 测试告警（验证通道可用性） */
export const TestAlertSchema = z.object({
  title: z.string().min(1).max(100).default('测试告警'),
  message: z.string().min(1).max(500).default('这是一条来自监控模块的测试告警'),
  channels: z.array(AlertChannel).min(1),
})
export type TestAlertDto = z.infer<typeof TestAlertSchema>

/** 健康检查（探针用） */
export const MonitorHealthSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  uptimeSeconds: z.number(),
  checks: z.record(z.enum(['ok', 'failed'])),
})
export type MonitorHealthModel = z.infer<typeof MonitorHealthSchema>
