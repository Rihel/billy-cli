import { z } from 'zod'
import {
  CredentialKind,
  CredentialLifetime,
  CredentialRefresh,
  CredentialStatus,
} from '../dicts/credential.dict'
import { CredentialInjectRuleSchema } from '../credential/inject-rule.schema'
import { BaseModelSchema } from './base.schema'

/** 取值来自字典的枚举字段（单一事实源） */
const enumOf = (dict: { values: readonly unknown[] }) =>
  z.enum(dict.values as unknown as [string, ...string[]])

export const CredentialKindSchema = enumOf(CredentialKind)
export const CredentialLifetimeSchema = enumOf(CredentialLifetime)
export const CredentialRefreshSchema = enumOf(CredentialRefresh)
export const CredentialStatusSchema = enumOf(CredentialStatus)

/** 归属体系：个人凭据只属于某个人（`user` / `admin`） */
export const CredentialOwnerTypeSchema = z.enum(['user', 'admin'])

/**
 * 凭据对外模型 —— **永不包含明文与密文**。
 *
 * 页面能看到的只有：`config`（明文配置，如 host / port / username）与 `secretHint`
 * （`root` / `AKID…abcd` 这类辨认用的提示）。凭据值对任何角色都不开放（§6.10.3 硬边界）。
 */
export const CredentialModelSchema = BaseModelSchema.extend({
  ownerType: CredentialOwnerTypeSchema,
  ownerId: z.string(),
  provider: z.string(),
  name: z.string(),
  kind: CredentialKindSchema,
  template: z.string(),
  lifetime: CredentialLifetimeSchema,
  refresh: CredentialRefreshSchema,
  expiresAt: z.union([z.string(), z.date()]).nullable(),
  /** 展示用提示（不含完整值） */
  secretHint: z.string().nullable(),
  /** 模板里 `scope=config` 的字段（明文） */
  config: z.record(z.string(), z.unknown()),
  /** 注入规则（文件 / 环境变量） */
  inject: z.array(CredentialInjectRuleSchema),
  status: CredentialStatusSchema,
  lastUsedAt: z.union([z.string(), z.date()]).nullable(),
})
export type CredentialModel = z.infer<typeof CredentialModelSchema>

/** 列表入参：可选按 provider / 关键字（name、hint）过滤；个人凭据量级小，不做分页 */
export const CredentialListSchema = z.object({
  provider: z.string().max(32).optional(),
  keyword: z.string().max(64).optional(),
})
export type CredentialListDto = z.infer<typeof CredentialListSchema>

/**
 * 绑定入参：**模型只传 provider（+ 可选 name），字段值由表单按模板采集**。
 *
 * `values` 是模板字段的原始值（键由模板定义），服务端按模板校验并拆分明文 / 密文；
 * 不入库的额外键会被丢弃。
 */
export const CredentialBindSchema = z.object({
  provider: z.string().min(1).max(32),
  /** 用户命名（同一 provider 可绑多个账号）；省略时取 provider */
  name: z.string().trim().min(1).max(64).optional(),
  /** 字段模板标识；省略取 provider 同名模板 */
  template: z.string().min(1).max(32).optional(),
  lifetime: CredentialLifetimeSchema.optional(),
  /** `temporary` 时必填（服务端校验） */
  expiresAt: z.union([z.string(), z.date()]).optional(),
  values: z.record(z.string(), z.unknown()),
  /** 注入规则；省略则用模板默认值 */
  inject: z.array(CredentialInjectRuleSchema).optional(),
})
export type CredentialBindDto = z.infer<typeof CredentialBindSchema>

/** 单条定位（detail / remove / update-inject 共用） */
export const CredentialIdSchema = z.object({
  credentialId: z.string().min(1).max(20),
})
export type CredentialIdDto = z.infer<typeof CredentialIdSchema>

/** "修改映射"：只改注入规则，不动凭据值（改值必须重新绑定，AAD 才不会被绕过） */
export const CredentialUpdateInjectSchema = CredentialIdSchema.extend({
  inject: z.array(CredentialInjectRuleSchema).max(16, '注入规则最多 16 条'),
})
export type CredentialUpdateInjectDto = z.infer<typeof CredentialUpdateInjectSchema>
