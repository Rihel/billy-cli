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
import { adapterOf, CREDENTIAL_COMMANDS } from './cli-adapters.js'

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

/** 命令行里的一段：`cd x && gh pr list` → [{ cd, [x] }, { gh, [pr, list] }] */
export interface CommandSegment {
  /** 段内第一条命令（已跳过 sudo / env / 环境变量赋值，取 basename） */
  command: string
  /** 该段命令的参数（不含命令本身） */
  args: readonly string[]
}

/** 把一条命令行拆成各段（`;` / `&&` / `||` / `|` / 换行分隔） */
export const segmentsOfLine = (line: string): CommandSegment[] => {
  const segments: CommandSegment[] = []
  for (const segment of line.split(/\n|;|\|\||&&|\|/)) {
    const tokens = segment.trim().split(/\s+/).filter(Boolean)
    let index = 0
    while (
      index < tokens.length &&
      (SKIPPED_PREFIXES.has(tokens[index]) || ENV_ASSIGNMENT.test(tokens[index]))
    ) {
      index += 1
    }
    const first = tokens[index]
    if (!first) continue
    const unquoted = first.replace(/^['"]|['"]$/g, '')
    segments.push({
      command: unquoted.split('/').pop() ?? unquoted,
      args: tokens.slice(index + 1),
    })
  }
  return segments
}

/** 把一条命令行拆成"每段的第一条命令"（`cd x && gh pr list` → [cd, gh]） */
export const commandsOfLine = (line: string): string[] =>
  segmentsOfLine(line).map((segment) => segment.command)

const providerOfCommand = (command: string): string | undefined =>
  Object.entries(CREDENTIAL_COMMANDS).find(([, commands]) => commands.includes(command))?.[0]

/**
 * **无副作用探测命令**：对所有 provider 豁免。
 *
 * `lark-cli --help` / `gh --version` 不会碰凭据，被预检拦下只会让模型以为「平台坏了」。
 */
const SAFE_PROBE_PREFIXES: readonly (readonly string[])[] = [
  ['help'],
  ['--help'],
  ['-h'],
  ['--version'],
  ['-v'],
  ['version'],
]

const startsWithPrefix = (args: readonly string[], prefix: readonly string[]): boolean =>
  prefix.length > 0 && prefix.every((token, index) => args[index] === token)

/** 这一段是不是「配置 / 登录态 / 纯探测」命令：是则跳过凭据预检 */
const isBootstrapSegment = (provider: string, args: readonly string[]): boolean =>
  SAFE_PROBE_PREFIXES.some((prefix) => startsWithPrefix(args, prefix)) ||
  (adapterOf(provider)?.bootstrap ?? []).some((prefix) => startsWithPrefix(args, prefix))

/**
 * 执行前检查（`docs/design/workspace-cli-credentials.md` §6.4.4）。
 *
 * 规则（按段判定，逐条）：
 * - 段是初始化 / 登录态命令（适配器 `bootstrap`）或无副作用探测 → **放行该段**；
 * - 段命中某 provider，且清单里有该 provider 的**未过期**凭据 → 放行；
 * - 命中但缺失 / 已过期 → 拒绝（返回原因，由模型转告用户）；
 * - 未命中任何 provider → 放行。
 *
 * 豁免**只到子命令**：`lark-cli config init && lark-cli im send` 里业务段照旧检查。
 * 纯本地、零 RPC：拒绝策略不引入额外延迟，也不受控制面可用性影响。
 */
export const checkCommandCredentials = (
  line: string,
  manifest: CredentialManifest | null,
  now = Date.now(),
): CredentialGateDenial | null => {
  const items = manifest?.items ?? []
  for (const segment of segmentsOfLine(line)) {
    const provider = providerOfCommand(segment.command)
    if (!provider) continue
    if (isBootstrapSegment(provider, segment.args)) continue

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
