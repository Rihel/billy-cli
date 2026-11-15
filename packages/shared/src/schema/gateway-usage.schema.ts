import { z } from 'zod'
import { BasePaginateSchema } from './base.schema'

/** 日期（YYYY-MM-DD，按上海业务日） */
const dateKey = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期必须是 YYYY-MM-DD')

const dateField = z.union([z.string(), z.date()]).optional()

/** 调用状态（与 model_gateway_usage.status 一致） */
export const GatewayUsageStatusSchema = z.enum(['success', 'error', 'aborted', 'rejected'])
export type GatewayUsageStatus = z.infer<typeof GatewayUsageStatusSchema>

/** 明细行：一次上游尝试 */
export const GatewayUsageItemSchema = z.object({
  id: z.string(),
  requestId: z.string(),
  attempt: z.number().int(),
  runId: z.string().nullable(),
  conversationId: z.string().nullable(),
  identityType: z.string().nullable(),
  identityId: z.string().nullable(),
  providerId: z.string().nullable(),
  providerName: z.string().nullable(),
  modelId: z.string().nullable(),
  modelKey: z.string().nullable(),
  modelName: z.string().nullable(),
  keyId: z.string().nullable(),
  stream: z.boolean(),
  status: GatewayUsageStatusSchema,
  httpStatus: z.number().int().nullable(),
  errorCode: z.number().int().nullable(),
  unitType: z.string(),
  inputTokens: z.number().nullable(),
  outputTokens: z.number().nullable(),
  totalTokens: z.number().nullable(),
  cacheReadTokens: z.number().nullable(),
  cacheWriteTokens: z.number().nullable(),
  reasoningTokens: z.number().nullable(),
  units: z.number().nullable(),
  costMicros: z.number().nullable(),
  priceSnapshot: z.record(z.string(), z.unknown()).nullable(),
  ttftMs: z.number().int().nullable(),
  durationMs: z.number().int().nullable(),
  usageMissing: z.boolean(),
  createdAt: dateField,
})
export type GatewayUsageItemModel = z.infer<typeof GatewayUsageItemSchema>

/** 明细查询 */
export const GatewayUsageListSchema = BasePaginateSchema.extend({
  from: dateKey.optional(),
  to: dateKey.optional(),
  providerId: z.string().max(32).optional(),
  modelId: z.string().max(32).optional(),
  runId: z.string().max(32).optional(),
  conversationId: z.string().max(32).optional(),
  status: GatewayUsageStatusSchema.optional(),
})
export type GatewayUsageListDto = z.infer<typeof GatewayUsageListSchema>

/** 汇总查询 */
export const GatewayUsageSummaryQuerySchema = z.object({
  from: dateKey.optional(),
  to: dateKey.optional(),
  providerId: z.string().max(32).optional(),
  modelId: z.string().max(32).optional(),
})
export type GatewayUsageSummaryQueryDto = z.infer<typeof GatewayUsageSummaryQuerySchema>

export const GatewayUsageTotalsSchema = z.object({
  calls: z.number().int(),
  success: z.number().int(),
  error: z.number().int(),
  aborted: z.number().int(),
  rejected: z.number().int(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  totalTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheWriteTokens: z.number(),
  reasoningTokens: z.number(),
  costMicros: z.number(),
  usageMissing: z.number().int(),
  avgDurationMs: z.number().int(),
  avgTtftMs: z.number().int(),
})
export type GatewayUsageTotalsModel = z.infer<typeof GatewayUsageTotalsSchema>

export const GatewayUsageDaySchema = z.object({
  date: z.string(),
  calls: z.number().int(),
  totalTokens: z.number(),
  costMicros: z.number(),
})
export type GatewayUsageDayModel = z.infer<typeof GatewayUsageDaySchema>

export const GatewayUsageDimensionSchema = z.object({
  key: z.string(),
  label: z.string(),
  calls: z.number().int(),
  totalTokens: z.number(),
  costMicros: z.number(),
})
export type GatewayUsageDimensionModel = z.infer<typeof GatewayUsageDimensionSchema>

export const GatewayUsageSummarySchema = z.object({
  from: z.string(),
  to: z.string(),
  totals: GatewayUsageTotalsSchema,
  byDay: z.array(GatewayUsageDaySchema),
  byModel: z.array(GatewayUsageDimensionSchema),
  byProvider: z.array(GatewayUsageDimensionSchema),
})
export type GatewayUsageSummaryModel = z.infer<typeof GatewayUsageSummarySchema>

/** 对账：同一 run 的 gateway 调用账 vs runs.usage */
export const GatewayUsageReconcileSchema = BasePaginateSchema.extend({
  from: dateKey.optional(),
  to: dateKey.optional(),
  /** 只看有差异的 run */
  onlyDiff: z.boolean().optional().default(false),
})
export type GatewayUsageReconcileDto = z.infer<typeof GatewayUsageReconcileSchema>

export const GatewayUsageReconcileItemSchema = z.object({
  runId: z.string(),
  conversationId: z.string().nullable(),
  gatewayCalls: z.number().int(),
  gatewayTotalTokens: z.number(),
  runTotalTokens: z.number().nullable(),
  delta: z.number().nullable(),
  runStatus: z.string().nullable(),
  runCreatedAt: dateField,
})
export type GatewayUsageReconcileItemModel = z.infer<typeof GatewayUsageReconcileItemSchema>

export const GatewayUsageReconcileResultSchema = z.object({
  from: z.string(),
  to: z.string(),
  /** 有 gateway 账、但 runs 里找不到的 run（孤儿） */
  orphanRuns: z.number().int(),
  comparedRuns: z.number().int(),
  mismatchRuns: z.number().int(),
  items: z.array(GatewayUsageReconcileItemSchema),
  total: z.number().int(),
})
export type GatewayUsageReconcileResultModel = z.infer<typeof GatewayUsageReconcileResultSchema>
