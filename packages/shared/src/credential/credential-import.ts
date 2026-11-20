import type { CredentialTemplate } from './credential-template.types'

/** 候选：本次可保存、且适配器能从容器内读到的 provider */
export interface CredentialCandidate {
  provider: string
  displayName: string
  /** 取到的是长期凭据还是短命 access token（后者要在确认界面明示） */
  longTerm: boolean
  expiresAt: string | null
}

/** 极简 `$.a.b` 取值（够导入映射用；不引入 JSONPath 依赖） */
export const pickJsonPath = (value: unknown, path: string | undefined): unknown => {
  if (!path) return value
  let current = value
  for (const key of path
    .replace(/^\$\.?/, '')
    .split('.')
    .filter(Boolean)) {
    if (current === null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

/**
 * 导入值该写进模板的哪个字段。
 *
 * 适配器可以显式声明 `field`；没声明时取模板里**唯一**的必填 secret 字段
 * （如 github 的 `token`、lark 的 `accessToken`）。多字段却没说写哪个 → 报错，不猜。
 */
export const resolveImportField = (template: CredentialTemplate, field?: string): string => {
  if (field) {
    const exists = template.fields.some((item) => item.key === field && item.scope === 'secret')
    if (!exists) throw new Error(`导入字段 ${field} 不在模板 ${template.provider} 的 secret 里`)
    return field
  }
  const requiredSecrets = template.fields.filter((item) => item.scope === 'secret' && item.required)
  if (requiredSecrets.length === 1) return requiredSecrets[0].key
  throw new Error(`模板 ${template.provider} 有多个 secret 字段，导入必须显式指定 field`)
}
