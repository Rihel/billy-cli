import { z } from 'zod'
import {
  ConnectorAuthBase,
  ConnectorAuthSubject,
  ConnectorKind,
  ConnectorStatus,
  ConnectorTransport,
} from '../dicts/ai-connector.dict'
import { BasePaginateSchema } from './base.schema'

/**
 * 连接器模块的数据结构（`/ai-connector/*`，全部后台管理员鉴权）—— 设计
 * `docs/design/ai-connector.md` §3.2 / §3.10。
 *
 * 四条口径：
 * - **配置与密钥分开**：`config` 是非密钥配置（地址 / 超时 / 库名），`secrets` 才是密钥；
 * - **密钥明文入库**（沿用 2026-10-01 的工程取舍），接口**只回提示串**，不回明文；
 * - **状态不是实时连接**：`status` 只是"上次测试的结论"，本期不做常驻会话；
 * - **工具治理在别处**：本模块只管实例；工具的开关 / 限额 / 作用域仍在 `/ai-tool/*`。
 */

const enumField = (dict: { values: readonly string[] }) =>
  z.enum(dict.values as unknown as [string, ...string[]])

/** 实例 key：小写字母 / 数字 / 连字符，1~32 位（工具 key 前缀会用到） */
export const ConnectorKeySchema = z
  .string()
  .min(1)
  .max(32)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, '只允许小写字母、数字与单个连字符')

/** 列表 */
export const AiConnectorListSchema = BasePaginateSchema.extend({
  keyword: z.string().max(64).optional(),
  enabled: z.boolean().optional(),
})
export type AiConnectorListDto = z.infer<typeof AiConnectorListSchema>

/** 新建：一台外部服务一条实例 */
export const AiConnectorCreateSchema = z.object({
  key: ConnectorKeySchema,
  name: z.string().min(1).max(64),
  /** 目录型号（`postgres` / `mysql` / `redis`），决定表单字段与默认值 */
  catalogKind: z.string().min(1).max(32),
  /** 驱动标识（由型号映射：`sql` / `redis`） */
  driver: z.string().min(1).max(32),
  config: z.record(z.string(), z.unknown()).default({}),
  /** 密钥明文（接口不会回传；空对象 = 无需密钥） */
  secrets: z.record(z.string(), z.string()).default({}),
  enabled: z.boolean().default(true),
})
export type AiConnectorCreateDto = z.infer<typeof AiConnectorCreateSchema>

/** 更新：省略的字段 = 不改；`secrets` 里给空串 = 清空该密钥 */
export const AiConnectorUpdateSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(64).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  secrets: z.record(z.string(), z.string()).optional(),
  enabled: z.boolean().optional(),
})
export type AiConnectorUpdateDto = z.infer<typeof AiConnectorUpdateSchema>

/** 只按 id 操作（详情 / 测试 / 同步 / 删除） */
export const AiConnectorIdSchema = z.object({ id: z.string().min(1) })
export type AiConnectorIdDto = z.infer<typeof AiConnectorIdSchema>

/** 密钥字段的展示信息（永不回明文） */
export const AiConnectorSecretHintSchema = z.object({
  name: z.string(),
  label: z.string(),
  required: z.boolean(),
  hint: z.string().nullable(),
})
export type AiConnectorSecretHint = z.infer<typeof AiConnectorSecretHintSchema>

/** 目录里的一个型号（代码声明，页面据此渲染卡片与表单） */
export const AiConnectorCatalogEntrySchema = z.object({
  kind: z.string(),
  name: z.string(),
  description: z.string(),
  driver: z.string(),
  transport: enumField(ConnectorTransport),
  category: z.string(),
  phase: z.enum(['available', 'coming_soon']),
  authHint: z.string().nullable(),
  fields: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      type: z.enum(['text', 'password', 'url', 'number']),
      secret: z.boolean(),
      required: z.boolean(),
      placeholder: z.string().nullable(),
      help: z.string().nullable(),
    }),
  ),
})
export type AiConnectorCatalogEntry = z.infer<typeof AiConnectorCatalogEntrySchema>

/** 实例的展示模型（列表 / 详情） */
export const AiConnectorModelSchema = z.object({
  id: z.string(),
  key: z.string(),
  name: z.string(),
  catalogKind: z.string(),
  driver: z.string(),
  kind: enumField(ConnectorKind),
  transport: enumField(ConnectorTransport),
  authBase: enumField(ConnectorAuthBase),
  authSubject: enumField(ConnectorAuthSubject),
  config: z.record(z.string(), z.unknown()),
  secretHints: z.array(AiConnectorSecretHintSchema),
  enabled: z.boolean(),
  status: enumField(ConnectorStatus),
  lastError: z.string().nullable(),
  lastCheckedAt: z.union([z.string(), z.date()]).nullable(),
  toolCount: z.number().int(),
  allowedTools: z.array(z.string()).nullable(),
  createdAt: z.union([z.string(), z.date()]),
  updatedAt: z.union([z.string(), z.date()]),
})
export type AiConnectorModel = z.infer<typeof AiConnectorModelSchema>

/** 详情：实例 + 它产出的工具（工具治理仍在 `/ai-tool/*`） */
export const AiConnectorDetailSchema = AiConnectorModelSchema.extend({
  tools: z.array(
    z.object({
      toolKey: z.string(),
      remoteName: z.string(),
      title: z.string().nullable(),
      enabled: z.boolean(),
    }),
  ),
})
export type AiConnectorDetail = z.infer<typeof AiConnectorDetailSchema>

/** 测试连接 / 同步的结果（同步失败不抛接口错误，而是回一个结论） */
export const AiConnectorActionResultSchema = z.object({
  ok: z.boolean(),
  message: z.string().nullable(),
  toolCount: z.number().int().optional(),
})
export type AiConnectorActionResult = z.infer<typeof AiConnectorActionResultSchema>
