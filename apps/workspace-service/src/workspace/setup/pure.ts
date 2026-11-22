import { createHash } from 'node:crypto'
import type { WorkspaceSetupPackage, WorkspaceSetupReport } from '@repo/shared'
import type { CredentialInjectRule } from '@repo/shared'

/** 安装命令（声明 → shell）；`spec` 里已锁版本，这里只负责拼接 */
export const installCommandOf = (pkg: WorkspaceSetupPackage): string => {
  switch (pkg.manager) {
    case 'npm':
      return `npm install -g --no-fund --no-audit ${pkg.spec}`
    case 'pnpm':
      return `pnpm add -g ${pkg.spec}`
    case 'apt':
      // 镜像已把 apt 源配成国内源，省掉 update（每次重建都 update 是几十秒）
      return `apt-get install -y --no-install-recommends ${pkg.spec}`
    case 'pip':
      return `pip install --no-input ${pkg.spec}`
    case 'uv':
      return `uv tool install ${pkg.spec}`
    default:
      throw new Error(`未知的安装管理器：${String(pkg.manager)}`)
  }
}

/** 安装项合并去重（默认清单 + 工作区追加；同一 manager+spec 只装一次） */
export const mergeSetupPackages = (
  base: WorkspaceSetupPackage[],
  extra: WorkspaceSetupPackage[],
): WorkspaceSetupPackage[] => {
  const seen = new Set<string>()
  const merged: WorkspaceSetupPackage[] = []
  for (const pkg of [...base, ...extra]) {
    const key = `${pkg.manager}:${pkg.spec}`
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(pkg)
  }
  return merged
}

/**
 * 清单哈希：**只覆盖声明**（安装项 + 技能内容），不覆盖凭据。
 *
 * 用途是幂等标记 `.billy/setup/<setupId>@<hash>.done`：声明没变就不重装。
 * 凭据每次 ensure 都重新落地（便宜且能保证正确），所以不进哈希。
 */
export const setupHashOf = (input: {
  setupId: string
  packages: WorkspaceSetupPackage[]
  skills: { key: string; contentHash: string }[]
}): string =>
  createHash('sha256')
    .update(
      JSON.stringify({
        setupId: input.setupId,
        packages: input.packages.map((pkg) => [pkg.manager, pkg.spec, pkg.verify]),
        skills: [...input.skills].sort((left, right) => left.key.localeCompare(right.key)),
      }),
    )
    .digest('hex')
    .slice(0, 16)

/** 注入模板的字段路径替换：`${config.host}` / `${secret.password}` */
const TEMPLATE_PATTERN = /\$\{(config|secret)\.([A-Za-z0-9_]+)\}/g

/**
 * 渲染一条注入规则（§6.4.3）。
 *
 * - `file`：把模板渲染成文件内容（模板里引用的字段缺失 → 这条规则失败，不写半截文件）；
 * - `env`：`field` 缺省取**唯一的** secret 字段；多字段却没说取哪个也是错误（不猜）。
 *
 * **渲染出的内容就是凭据明文**：只交给调用方写文件，不返回、不记录、不进日志。
 */
export const renderInjectRules = (
  rules: CredentialInjectRule[],
  values: { config: Record<string, unknown>; secret: Record<string, unknown> },
): {
  files: { path: string; content: string }[]
  env: Record<string, string>
  errors: string[]
} => {
  const files: { path: string; content: string }[] = []
  const env: Record<string, string> = {}
  const errors: string[] = []
  const secretKeys = Object.keys(values.secret)

  for (const rule of rules) {
    if (rule.type === 'file') {
      const missing: string[] = []
      const content = rule.template.replace(
        TEMPLATE_PATTERN,
        (_match, scope: string, key: string) => {
          const source = scope === 'secret' ? values.secret : values.config
          const value = source[key]
          if (value === undefined || value === null) {
            missing.push(`${scope}.${key}`)
            return ''
          }
          return String(value)
        },
      )
      if (missing.length > 0) {
        errors.push(`注入文件 ${rule.path} 失败：模板引用的字段 ${missing.join('、')} 不存在`)
        continue
      }
      files.push({ path: rule.path, content })
      continue
    }

    const field = rule.field ?? (secretKeys.length === 1 ? secretKeys[0] : undefined)
    if (!field) {
      errors.push(`环境变量 ${rule.name} 未指定字段，且凭据不是单字段（不猜）`)
      continue
    }
    const value = values.secret[field] ?? values.config[field]
    if (value === undefined || value === null) {
      errors.push(`环境变量 ${rule.name} 引用的字段 ${field} 不存在`)
      continue
    }
    env[rule.name] = String(value)
  }

  return { files, env, errors }
}

/** 报告里一条记录的便捷构造（append 型） */
export const reportEntry = <T extends { spec?: string; skillKey?: string; name?: string }>(
  target: T,
  outcome: WorkspaceSetupReport['packages'][number]['outcome'],
  message?: string,
): T & { outcome: typeof outcome; message?: string } => ({
  ...target,
  outcome,
  ...(message ? { message } : {}),
})
