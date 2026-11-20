import { z } from 'zod'
import type { CredentialField, CredentialTemplate } from './credential-template.types'

/** 空串 / null 视为"没填"：表单与 JSON 都会产生这两种空值 */
const emptyToUndefined = (value: unknown): unknown =>
  value === '' || value === null || value === undefined ? undefined : value

/**
 * 单字段校验（由模板派生，不在代码里手写每个 provider 的规则）。
 *
 * 口径：
 * - 必填字段缺省 → 中文提示「请填写 X」；
 * - **有默认值的字段可以不填**（端口 / 库号 / 地域），默认值参与校验；
 * - 选填字段留空 → 视为未提供（不写进 `config` / `secret`）；
 * - `number` 允许表单传来字符串（`"3306"`），统一 coerce 成整数；
 * - `url` 必须是合法绝对地址。
 */
const credentialFieldSchema = (field: CredentialField): z.ZodTypeAny => {
  if (field.type === 'number') {
    let number: z.ZodTypeAny = z.coerce
      .number({ message: `请填写${field.label}（数字）` })
      .int(`${field.label}必须是整数`)
      .min(0, `${field.label}不能为负数`)
    if (field.default !== undefined) number = number.default(Number(field.default))
    else if (!field.required) number = number.optional()
    return z.preprocess(emptyToUndefined, number)
  }

  const text =
    field.type === 'url'
      ? z
          .string({ message: `请填写${field.label}` })
          .trim()
          .url(`请填写合法的${field.label}`)
      : z.string({ message: `请填写${field.label}` }).trim()
  let schema: z.ZodTypeAny = field.required ? text.min(1, `请填写${field.label}`) : text
  if (field.default !== undefined) schema = text.default(String(field.default))
  else if (!field.required) schema = text.optional()
  return z.preprocess(emptyToUndefined, schema)
}

/**
 * 按模板生成"用户输入"的 zod schema（前端表单 / 后端入参共用同一份规则）。
 *
 * 输出即**最终入库形态**：默认值已补齐、`number` 已转数字、未声明的键被丢弃。
 */
export const buildCredentialValuesSchema = (
  template: CredentialTemplate,
): z.ZodObject<Record<string, z.ZodTypeAny>> =>
  z.object(
    Object.fromEntries(template.fields.map((field) => [field.key, credentialFieldSchema(field)])),
  )

/**
 * 按 `scope` 拆分：`config` 进明文列，`secret` 打包进密文信封。
 *
 * 这是"哪些字段加密"的**唯一判据**：判据来自模板，不在业务代码里写字段名。
 */
export const splitCredentialValues = (
  template: CredentialTemplate,
  values: Record<string, unknown>,
): { config: Record<string, unknown>; secret: Record<string, unknown> } => {
  const config: Record<string, unknown> = {}
  const secret: Record<string, unknown> = {}
  for (const field of template.fields) {
    const value = values[field.key]
    if (value === undefined) continue
    if (field.scope === 'secret') secret[field.key] = value
    else config[field.key] = value
  }
  return { config, secret }
}

/** 尾部截断式提示：`AKIDxxxx…abcd`（不足 9 位一律星号，避免把短密钥整段暴露） */
export const maskCredentialHint = (value: string, mode: 'plain' | 'tail'): string => {
  if (mode === 'plain') return value.length > 32 ? `${value.slice(0, 32)}…` : value
  if (value.length <= 8) return '***'
  return `${value.slice(0, 4)}…${value.slice(-4)}`
}

/**
 * 计算 `secret_hint`（界面据此辨认"是哪一份凭据"，不含完整值）。
 *
 * 取 `hintField` 指的那个字段；没配就退到第一个 secret 字段，再退到第一个 config 字段。
 * 一个值都没有（例如 Redis 无密码）时返回 `null`。
 */
export const credentialHintOf = (
  template: CredentialTemplate,
  config: Record<string, unknown>,
  secret: Record<string, unknown>,
): string | null => {
  const read = (key: string): unknown => secret[key] ?? config[key]

  let value: unknown
  if (template.hintField) {
    value = read(template.hintField)
  }
  if (value === undefined || value === null || value === '') {
    value = Object.values(secret)[0] ?? Object.values(config)[0]
  }
  if (value === undefined || value === null || value === '') return null

  return maskCredentialHint(String(value), template.hintMode ?? 'plain')
}
