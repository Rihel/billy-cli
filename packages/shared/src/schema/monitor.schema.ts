import { z } from 'zod'
import { BaseModelSchema, BasePaginateSchema } from './base.schema'

/** 告警通道（对应通知模块 NotifyChannel：file / lark / email） */
export const AlertChannelSchema = z.enum(['file', 'lark', 'email'])

/** 告警级别：warn / error / critical */
export const MonitorLevelSchema = z.enum(['warn', 'error', 'critical'])

/** 规则分类：系统指标 / 业务指标 */
export const MonitorCategorySchema = z.enum(['system', 'business'])

/** 规则类型：指标规则 / 事件规则 */
export const MonitorRuleKindSchema = z.enum(['metric', 'event'])

/** 驱动：batch（周期无状态）/ stream（跨 tick 累积，P2） */
export const MonitorRuleDriverSchema = z.enum(['batch', 'stream'])

/** 指标比较符 */
export const MonitorOperatorSchema = z.enum(['gt', 'gte', 'lt', 'lte'])

/** 指标类型 */
export const MonitorMetricKindSchema = z.enum(['raw', 'derived'])

/** 告警状态 */
export const MonitorAlertStatusSchema = z.enum(['firing', 'resolved'])

const dateField = z.union([z.string(), z.date()])

/**
 * 规则配置（库里的 `monitor_rules.config`）。
 *
 * 通用字段由页面统一渲染，规则自定义字段通过 `fields` 描述；未知字段保留，方便以后扩展。
 */
export const MonitorRuleConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    operator: MonitorOperatorSchema.default('gt'),
    threshold: z.number().default(0),
    channels: z.array(AlertChannelSchema).min(1).default(['file']),
    silenceSeconds: z.number().int().min(0).default(300),
    level: MonitorLevelSchema.default('warn'),
    /** 连续多少个评估窗口不再命中后恢复 */
    recoverAfterWindows: z.number().int().min(1).max(10).default(2),
    /** 恢复时是否也发一条通知（默认只记录，不发） */
    notifyOnRecovery: z.boolean().default(false),
    /** stream 规则：连续多少个窗口满足条件才算命中 */
    streakWindows: z.number().int().min(1).max(30).default(3),
    /** 指标规则：维度过滤；不填就是 total */
    dimensionType: z.string().max(16).optional(),
    dimensionKey: z.string().max(128).optional(),
    /** 事件规则 */
    matchCodes: z.array(z.number().int()).optional(),
    keywords: z.array(z.string().min(1)).optional(),
  })
  .catchall(z.unknown())

export type MonitorRuleConfig = z.infer<typeof MonitorRuleConfigSchema>

/** 后台可编辑字段描述 */
export const MonitorRuleConfigFieldSchema = z.object({
  key: z.string(),
  label: z.string(),
  type: z.enum(['number', 'text', 'select', 'switch', 'multi-select']),
  min: z.number().optional(),
  max: z.number().optional(),
  step: z.number().optional(),
  options: z
    .array(z.object({ label: z.string(), value: z.union([z.string(), z.number()]) }))
    .optional(),
  description: z.string().optional(),
})
export type MonitorRuleConfigField = z.infer<typeof MonitorRuleConfigFieldSchema>

/** 规则定义元数据（来自代码，不含数据库 id） */
export const MonitorRuleDefinitionSchema = z.object({
  key: z.string(),
  name: z.string(),
  description: z.string(),
  category: MonitorCategorySchema,
  kind: MonitorRuleKindSchema,
  driver: MonitorRuleDriverSchema,
  metricKey: z.string().nullable().optional(),
  evaluationIntervalSeconds: z.number().int().positive(),
  windowSeconds: z.number().int().positive(),
  defaults: MonitorRuleConfigSchema,
  fields: z.array(MonitorRuleConfigFieldSchema),
  definitionVersion: z.string().optional(),
})
export type MonitorRuleDefinitionModel = z.infer<typeof MonitorRuleDefinitionSchema>

/** 规则实例（代码定义 + 库配置） */
export const MonitorRuleSchema = z.intersection(
  BaseModelSchema,
  z.object({
    ruleKey: z.string(),
    name: z.string(),
    description: z.string(),
    category: MonitorCategorySchema,
    kind: MonitorRuleKindSchema,
    driver: MonitorRuleDriverSchema,
    metricKey: z.string().nullable(),
    evaluationIntervalSeconds: z.number().int(),
    windowSeconds: z.number().int(),
    config: MonitorRuleConfigSchema,
    definitionVersion: z.string().nullable().optional(),
    enabled: z.boolean(),
    deprecated: z.boolean(),
    /** 最近一次告警时间（列表用，来自 monitor_alerts） */
    lastFiredAt: dateField.nullable().optional(),
  }),
)
export type MonitorRuleModel = z.infer<typeof MonitorRuleSchema>

export const ListMonitorRuleSchema = z.object({
  category: MonitorCategorySchema.optional(),
  keyword: z.string().optional(),
})
export type ListMonitorRuleDto = z.infer<typeof ListMonitorRuleSchema>

export const UpdateMonitorRuleSchema = z
  .object({
    ruleKey: z.string().min(1),
    config: MonitorRuleConfigSchema.partial().optional(),
    enabled: z.boolean().optional(),
  })
  .refine((input) => input.config !== undefined || input.enabled !== undefined, {
    message: 'config 和 enabled 至少改一个',
  })
export type UpdateMonitorRuleDto = z.infer<typeof UpdateMonitorRuleSchema>

export const ResetMonitorRuleSchema = z.object({ ruleKey: z.string().min(1) })
export type ResetMonitorRuleDto = z.infer<typeof ResetMonitorRuleSchema>

/** 测试告警（验证通道可用性） */
export const TestAlertSchema = z.object({
  title: z.string().min(1).max(100).default('测试告警'),
  message: z.string().min(1).max(500).default('这是一条来自监控模块的测试告警'),
  channels: z.array(AlertChannelSchema).min(1),
})
export type TestAlertDto = z.infer<typeof TestAlertSchema>

/** 指标定义元数据（指标页用） */
export const MonitorMetricDefinitionSchema = z.object({
  key: z.string(),
  title: z.string(),
  description: z.string(),
  kind: MonitorMetricKindSchema,
  category: MonitorCategorySchema,
  unit: z.string(),
  evaluationIntervalSeconds: z.number().int(),
  windowSeconds: z.number().int(),
  scope: z.enum(['instance', 'global']),
  dependsOn: z.array(z.string()).optional(),
})
export type MonitorMetricDefinitionModel = z.infer<typeof MonitorMetricDefinitionSchema>

/** 指标点（历史查询） */
export const MonitorMetricPointSchema = z.object({
  windowKey: z.string(),
  windowStart: dateField,
  windowEnd: dateField,
  value: z.number(),
  instanceId: z.string(),
  dimensionType: z.string(),
  dimensionKey: z.string(),
})
export type MonitorMetricPointModel = z.infer<typeof MonitorMetricPointSchema>

export const MonitorMetricSeriesSchema = z.object({
  metricKey: z.string().min(1),
  dimensionType: z.string().optional(),
  dimensionKey: z.string().optional(),
  instanceId: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  limit: z.number().int().min(1).max(5000).optional().default(1000),
})
export type MonitorMetricSeriesDto = z.infer<typeof MonitorMetricSeriesSchema>

export const MonitorMetricSeriesModelSchema = z.object({
  metricKey: z.string(),
  points: z.array(MonitorMetricPointSchema),
})
export type MonitorMetricSeriesModel = z.infer<typeof MonitorMetricSeriesModelSchema>

export const MonitorMetricLatestQuerySchema = z.object({
  metricKeys: z.array(z.string().min(1)).min(1).max(20),
  dimensionType: z.string().optional(),
  dimensionKey: z.string().optional(),
})
export type MonitorMetricLatestQueryDto = z.infer<typeof MonitorMetricLatestQuerySchema>

export const MonitorMetricLatestSchema = z.object({
  metricKey: z.string(),
  value: z.number(),
  windowKey: z.string(),
  windowEnd: dateField,
  instanceId: z.string(),
  dimensionType: z.string(),
  dimensionKey: z.string(),
})
export type MonitorMetricLatestModel = z.infer<typeof MonitorMetricLatestSchema>

/** 指标告警快照 */
export const MonitorMetricAlertSnapshotSchema = z.object({
  kind: z.literal('metric'),
  value: z.number(),
  threshold: z.number(),
  operator: z.string(),
  window: z.object({
    key: z.string(),
    start: z.string(),
    end: z.string(),
  }),
  samples: z.array(
    z.object({
      windowKey: z.string(),
      value: z.number(),
      instanceId: z.string(),
      dimensionType: z.string(),
      dimensionKey: z.string(),
    }),
  ),
  labels: z.record(z.string(), z.string()).optional(),
})

/** 事件告警快照 */
export const MonitorEventAlertSnapshotSchema = z.object({
  kind: z.literal('event'),
  code: z.number().optional(),
  message: z.string(),
  stack: z.string().optional(),
  path: z.string().optional(),
  requestId: z.string().optional(),
  at: z.string(),
})

export const MonitorAlertSnapshotSchema = z.union([
  MonitorMetricAlertSnapshotSchema,
  MonitorEventAlertSnapshotSchema,
])
export type MonitorAlertSnapshot = z.infer<typeof MonitorAlertSnapshotSchema>

/** 告警记录（一条告警的生命周期） */
export const MonitorAlertSchema = z.intersection(
  BaseModelSchema,
  z.object({
    ruleKey: z.string(),
    ruleName: z.string(),
    kind: MonitorRuleKindSchema,
    level: MonitorLevelSchema,
    subjectId: z.string(),
    instanceId: z.string(),
    status: MonitorAlertStatusSchema,
    firstFiredAt: dateField,
    lastFiredAt: dateField,
    recoveredAt: dateField.nullable().optional(),
    durationMs: z.number().nullable().optional(),
    missCount: z.number().int().optional(),
    value: z.number().nullable().optional(),
    threshold: z.number().nullable().optional(),
    windowKey: z.string().nullable().optional(),
    firstSnapshot: MonitorAlertSnapshotSchema.nullable().optional(),
    lastSnapshot: MonitorAlertSnapshotSchema.nullable().optional(),
  }),
)
export type MonitorAlertModel = z.infer<typeof MonitorAlertSchema>

/** 发送记录（逐通道） */
export const MonitorAlertDeliverySchema = z.intersection(
  BaseModelSchema,
  z.object({
    alertId: z.string().nullable(),
    ruleId: z.string().nullable(),
    ruleName: z.string(),
    title: z.string(),
    message: z.string(),
    channel: AlertChannelSchema,
    status: z.enum(['success', 'failed']),
    error: z.string().nullable().optional(),
    sentAt: dateField,
  }),
)
export type MonitorAlertDeliveryModel = z.infer<typeof MonitorAlertDeliverySchema>

export const MonitorAlertDetailSchema = z.object({
  alert: MonitorAlertSchema,
  deliveries: z.array(MonitorAlertDeliverySchema),
})
export type MonitorAlertDetailModel = z.infer<typeof MonitorAlertDetailSchema>

export const PageQueryMonitorAlertSchema = BasePaginateSchema.extend({
  ruleKey: z.string().optional(),
  level: MonitorLevelSchema.optional(),
  status: MonitorAlertStatusSchema.optional(),
  subjectId: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  orderBy: z
    .enum(['firstFiredAt', 'lastFiredAt', 'recoveredAt'])
    .optional()
    .default('firstFiredAt'),
  order: z.enum(['asc', 'desc']).optional().default('desc'),
})
export type PageQueryMonitorAlertDto = z.infer<typeof PageQueryMonitorAlertSchema>

export const GetMonitorAlertDetailSchema = z.object({ alertId: z.string().min(1) })
export type GetMonitorAlertDetailDto = z.infer<typeof GetMonitorAlertDetailSchema>

export const PageQueryMonitorLogSchema = BasePaginateSchema.extend({
  alertId: z.string().optional(),
  ruleId: z.string().optional(),
  channel: AlertChannelSchema.optional(),
  status: z.enum(['success', 'failed']).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  orderBy: z.enum(['sentAt', 'createdAt']).optional().default('sentAt'),
  order: z.enum(['asc', 'desc']).optional().default('desc'),
})
export type PageQueryMonitorLogDto = z.infer<typeof PageQueryMonitorLogSchema>

export const MonitorEngineSlotStatusSchema = z.object({
  intervalSeconds: z.number().int(),
  lastRunAt: dateField.nullable(),
  lastDurationMs: z.number().nullable(),
  running: z.boolean(),
})

export const MonitorEngineMetricStatusSchema = z.object({
  metricKey: z.string(),
  lastSampleAt: dateField.nullable(),
  stale: z.boolean(),
})

export const MonitorEngineRuleStatusSchema = z.object({
  ruleKey: z.string(),
  lastEvaluatedAt: dateField.nullable(),
  lastFiredAt: dateField.nullable(),
})

export const MonitorEngineStatusSchema = z.object({
  instanceId: z.string(),
  leader: z.boolean(),
  slots: z.array(MonitorEngineSlotStatusSchema),
  metrics: z.array(MonitorEngineMetricStatusSchema),
  rules: z.array(MonitorEngineRuleStatusSchema),
})
export type MonitorEngineStatusModel = z.infer<typeof MonitorEngineStatusSchema>

/** 健康检查（探针用） */
export const MonitorHealthSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  uptimeSeconds: z.number(),
  // Zod 4 起 z.record 需要显式 key schema（Zod 3 的单参写法已不合法）
  checks: z.record(z.string(), z.enum(['ok', 'failed'])),
})
export type MonitorHealthModel = z.infer<typeof MonitorHealthSchema>
