import { describe, expect, it } from 'vitest'
import {
  checkCommandCredentials,
  commandsOfLine,
  gateMessageOf,
  type CredentialManifest,
} from '../src/workspace/credential-gate.js'

/**
 * 执行前检查（`docs/design/workspace-cli-credentials.md` §6.4.4）。
 *
 * 三条规则：命中且有未过期凭据 → 放行；命中但缺失 / 过期 → 拒绝；未命中 → 放行。
 * 纯本地、零 RPC —— 这里只用内存清单验证。
 */

const NOW = Date.parse('2026-11-20T10:00:00.000Z')
const manifest = (items: CredentialManifest['items']): CredentialManifest => ({ items })

describe('命令识别', () => {
  it('复合命令只取每段的第一条命令', () => {
    expect(commandsOfLine('cd /tmp && gh pr list')).toEqual(['cd', 'gh'])
    expect(commandsOfLine('echo a; mysql -u root | head')).toEqual(['echo', 'mysql', 'head'])
  })

  it('跳过 sudo / env / 环境变量赋值，取真实命令', () => {
    expect(commandsOfLine('sudo gh auth status')).toEqual(['gh'])
    expect(commandsOfLine('FOO=1 BAR=2 gh pr list')).toEqual(['gh'])
    expect(commandsOfLine('/usr/local/bin/lark-cli --version')).toEqual(['lark-cli'])
  })
})

describe('命中且有可用凭据 → 放行', () => {
  it('长期凭据与未过期的临时凭据都算可用', () => {
    const items = manifest([
      { provider: 'github', name: 'gh', expiresAt: null },
      { provider: 'lark', name: 'lark', expiresAt: '2026-11-20T12:00:00.000Z' },
    ])
    expect(checkCommandCredentials('gh pr list', items, NOW)).toBeNull()
    expect(checkCommandCredentials('lark-cli docs create', items, NOW)).toBeNull()
  })

  it('未命中任何 provider 的命令不检查（echo / ls / 自装 CLI）', () => {
    expect(checkCommandCredentials('echo hi', manifest([]), NOW)).toBeNull()
    expect(checkCommandCredentials('vercel deploy', manifest([]), NOW)).toBeNull()
  })
})

describe('命中但不可用 → 拒绝', () => {
  it('没有该 provider 的凭据 → missing（提示怎么补）', () => {
    const denial = checkCommandCredentials('gh pr list', manifest([]), NOW)
    expect(denial).toMatchObject({ provider: 'github', reason: 'missing' })
    expect(gateMessageOf(denial!)).toContain('缺少')
    expect(gateMessageOf(denial!)).toContain('凭据管理')
  })

  it('临时凭据已过期 → expired（与"没绑定"文案不同）', () => {
    const items = manifest([
      { provider: 'lark', name: 'lark', expiresAt: '2026-11-20T09:00:00.000Z' },
    ])
    const denial = checkCommandCredentials('lark notify', items, NOW)
    expect(denial).toMatchObject({ provider: 'lark', reason: 'expired' })
    expect(gateMessageOf(denial!)).toContain('已过期')
  })

  it('多段命令里只要有一段缺凭据就拒绝（不能靠前置命令绕过）', () => {
    const denial = checkCommandCredentials('echo start && mysql -e "select 1"', manifest([]), NOW)
    expect(denial).toMatchObject({ provider: 'mysql', reason: 'missing' })
  })
})

describe('初始化 / 登录态命令豁免（issue 1）', () => {
  it('配凭据的命令本身不被拦：清单里还没有该 provider 也要放行', () => {
    const empty = manifest([])
    expect(checkCommandCredentials('lark-cli config init --app-id cli_x', empty, NOW)).toBeNull()
    expect(checkCommandCredentials('lark-cli auth login', empty, NOW)).toBeNull()
    expect(checkCommandCredentials('gh auth login', empty, NOW)).toBeNull()
    expect(checkCommandCredentials('gh auth refresh -s repo', empty, NOW)).toBeNull()
  })

  it('豁免只到子命令：复合命令里的业务段照旧拒绝', () => {
    const denial = checkCommandCredentials(
      'lark-cli config init && lark-cli im send',
      manifest([]),
      NOW,
    )
    expect(denial).toMatchObject({ provider: 'lark', reason: 'missing' })
  })

  it('无副作用探测（--help / --version / doctor）对所有 provider 放行', () => {
    expect(checkCommandCredentials('lark-cli --help', manifest([]), NOW)).toBeNull()
    expect(checkCommandCredentials('mysql --version', manifest([]), NOW)).toBeNull()
    expect(checkCommandCredentials('lark-cli doctor', manifest([]), NOW)).toBeNull()
  })

  it('sudo / 环境变量前缀后的子命令同样识别', () => {
    expect(checkCommandCredentials('sudo gh auth status', manifest([]), NOW)).toBeNull()
  })
})
