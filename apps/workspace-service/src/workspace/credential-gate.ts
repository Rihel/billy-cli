import { credentialTemplateOf } from '@repo/shared'

/** 本地清单里的一条（`.billy/credentials.json` 的 items） */
export interface CredentialManifestItem {
  provider: string
  name: string
  expiresAt: string | null
}

/** `.billy/credentials.json`：执行前检查**只读这一份**，不查库、不做 RPC */
export interface CredentialManifest {
  version?: string
  items: CredentialManifestItem[]
}

/**
 * provider → 会暴露凭据的命令（命令识别）。
 *
 * 取自 CLI 适配器（§6.5 的 `commands`）：命令表与适配器同源，避免两处漂移。
 * 无适配器的 CLI 不在表里 —— 它们仍可正常使用，只是没有凭据预检。
 */
import { CREDENTIAL_COMMANDS } from './cli-adapters.js'

export { CREDENTIAL_COMMANDS }

/** 预检结论：命中某个 provider 但本地清单里没有可用凭据 */
export interface CredentialGateDenial {
  provider: string
  label: string
  reason: 'missing' | 'expired'
}

/** 行首可跳过的壳（`sudo gh …` / `env FOO=1 gh …` 仍要识别出 `gh`） */
const SKIPPED_PREFIXES = new Set(['sudo', 'env', 'command', 'nohup', 'time'])
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=\S*$/

/** 把一条命令行拆成"每段的第一条命令"（`cd x && gh pr list` → [cd, gh]） */
export const commandsOfLine = (line: string): string[] => {
  const commands: string[] = []
  for (const segment of line.split(/\n|;|\|\||&&|\|/)) {
    const tokens = segment.trim().split(/\s+/).filter(Boolean)
    let index = 0
    while (index < tokens.length) {
      const token = tokens[index]
      if (SKIPPED_PREFIXES.has(token) || ENV_ASSIGNMENT.test(token)) {
        index += 1
        continue
      }
      break
    }
    const first = tokens[index]
    if (!first) continue
    const unquoted = first.replace(/^['"]|['"]$/g, '')
    commands.push(unquoted.split('/').pop() ?? unquoted)
  }
  return commands
}

const providerOfCommand = (command: string): string | undefined =>
  Object.entries(CREDENTIAL_COMMANDS).find(([, commands]) => commands.includes(command))?.[0]

/**
 * 执行前检查（`docs/design/workspace-cli-credentials.md` §6.4.4）。
 *
 * 规则只有三条：
 * - 命令命中某 provider，且清单里有该 provider 的**未过期**凭据 → 放行；
 * - 命中但缺失 / 已过期 → 拒绝（返回原因，由模型转告用户）；
 * - 未命中任何 provider → 放行。
 *
 * 纯本地、零 RPC：拒绝策略不引入额外延迟，也不受控制面可用性影响。
 */
export const checkCommandCredentials = (
  line: string,
  manifest: CredentialManifest | null,
  now = Date.now(),
): CredentialGateDenial | null => {
  const items = manifest?.items ?? []
  for (const command of commandsOfLine(line)) {
    const provider = providerOfCommand(command)
    if (!provider) continue

    const candidates = items.filter((item) => item.provider === provider)
    const usable = candidates.some((item) => !item.expiresAt || Date.parse(item.expiresAt) > now)
    if (usable) continue

    return {
      provider,
      label: credentialTemplateOf(provider)?.label ?? provider,
      reason: candidates.length > 0 ? 'expired' : 'missing',
    }
  }
  return null
}

/** 拒绝时给模型 / 用户看的文案（中文，指明缺谁、下一步做什么） */
export const gateMessageOf = (denial: CredentialGateDenial): string =>
  denial.reason === 'expired'
    ? `「${denial.label}」凭据已过期，请先在凭据管理里重新绑定后再试`
    : `缺少「${denial.label}」凭据，请先在凭据管理里绑定后再试`
