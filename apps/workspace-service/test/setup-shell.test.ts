import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  createExecShell,
  createHostShell,
  type SetupExecResult,
} from '../src/workspace/setup/shell.js'

const cleanupDirs: string[] = []
afterAll(async () => {
  for (const dir of cleanupDirs) await rm(dir, { recursive: true, force: true })
})

/**
 * 初始化阶段的写文件（`createExecShell`）。
 *
 * 钉的是**分片**：内容 base64 后是 `printf` 的参数，Linux 单条 argv 上限 128KB，
 * 大文件（素材 360KB / 脚本 1MB）超过就直接 `argument list too long`（2026-11-22 实测）。
 * 所以每一片都必须是独立的一条命令，且片长留足余量。
 */

const ok: SetupExecResult = { ok: true, code: 0, stdout: '', stderr: '' }
const fail: SetupExecResult = { ok: false, code: 1, stdout: '', stderr: 'argument list too long' }

const makeShell = (failAt: number | null = null) => {
  const commands: string[] = []
  const shell = createExecShell(async (command) => {
    commands.push(command)
    return failAt !== null && commands.length === failAt ? fail : ok
  })
  return { shell, commands }
}

const payloadOf = (command: string): string | null =>
  /^printf %s '([^']*)' \| base64 -d >> /.exec(command)?.[1] ?? null

describe('写文件：大内容按片追加，单片命令远低于 argv 上限', () => {
  it('200KB 正文被切成多片，拼回来与原文一致，每片命令 < 100KB', async () => {
    const content = 'a'.repeat(200_000) + '尾巴'
    const { shell, commands } = makeShell()

    await shell.write('.agents/demo/big.md', content)

    // 第一条建目录并截断、最后一条改权限，中间都是分片追加
    expect(commands[0]).toContain('mkdir -p')
    expect(commands[0]).toContain(': >')
    expect(commands.at(-1)?.startsWith('chmod 600 ')).toBe(true)

    const chunks = commands.map(payloadOf).filter((item): item is string => item !== null)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.join('')).toBe(Buffer.from(content, 'utf8').toString('base64'))
    for (const command of commands) expect(command.length).toBeLessThan(100_000)
  })

  it('空内容也会真的落一个空文件（不追加任何分片）', async () => {
    const { shell, commands } = makeShell()

    await shell.write('.billy/empty.txt', '')

    expect(commands.map(payloadOf).filter(Boolean)).toEqual([])
    expect(commands[0]).toContain(': >')
    expect(commands.at(-1)?.startsWith('chmod 600 ')).toBe(true)
  })

  it('分片写失败时抛错并带上路径（调用方据此记 partial）', async () => {
    const { shell } = makeShell(3)

    await expect(shell.write('.agents/demo/big.md', 'b'.repeat(150_000))).rejects.toThrow(
      '写文件失败（.agents/demo/big.md）',
    )
  })
})

describe('批量写：多个小文件合并成一条命令，超片文件退回分片写', () => {
  it('两个小文件一次 exec 落盘，且各自内容正确', async () => {
    const { shell, commands } = makeShell()

    await shell.writeMany([
      { path: '.agents/demo/SKILL.md', content: '# demo' },
      { path: '.agents/demo/refs/a.md', content: 'ref-a' },
    ])

    // 一条批量命令：两个 mkdir / 两次 printf，同一次 exec
    expect(commands).toHaveLength(1)
    expect(commands[0]!.match(/mkdir -p/g)).toHaveLength(2)
    expect(commands[0]).toContain(Buffer.from('# demo').toString('base64'))
    expect(commands[0]).toContain(Buffer.from('ref-a').toString('base64'))
    expect(commands[0]!.length).toBeLessThan(100_000)
  })

  it('超过单条命令预算的大文件退回分片 write（不会撑爆 argv）', async () => {
    const { shell, commands } = makeShell()
    const big = 'a'.repeat(200_000)

    await shell.writeMany([{ path: '.agents/demo/big.md', content: big }])

    const chunks = commands.map(payloadOf).filter((item): item is string => item !== null)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.join('')).toBe(Buffer.from(big).toString('base64'))
    for (const command of commands) expect(command.length).toBeLessThan(100_000)
  })

  it('批量失败抛错（调用方据此退回逐个写）', async () => {
    const { shell } = makeShell(1)
    await expect(
      shell.writeMany([{ path: '.agents/demo/SKILL.md', content: '# demo' }]),
    ).rejects.toThrow('批量写文件失败')
  })
})

describe('Host 初始化 shell：~ 指向真实 HOME、不覆盖已有文件、越界安全', () => {
  it('~ 展开到注入的 HOME，不会落到 {工作区}/~', async () => {
    const root = await mkdtemp(join(tmpdir(), 'billy-host-root-'))
    const home = await mkdtemp(join(tmpdir(), 'billy-host-home-'))
    cleanupDirs.push(root, home)
    const shell = createHostShell(root, async () => ok, { allowHome: true, home })

    await shell.write('~/.lark-cli/config.json', '{"appId":"x"}')

    expect(await readFile(join(home, '.lark-cli/config.json'), 'utf8')).toBe('{"appId":"x"}')
    await expect(stat(join(root, '~'))).rejects.toBeTruthy()
    expect((await stat(join(home, '.lark-cli/config.json'))).mode & 0o777).toBe(0o600)
  })

  it('HOME 下已有文件不覆盖（保护用户自己的 CLI 登录态）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'billy-host-root-'))
    const home = await mkdtemp(join(tmpdir(), 'billy-host-home-'))
    cleanupDirs.push(root, home)
    const shell = createHostShell(root, async () => ok, { allowHome: true, home })

    await shell.write('~/.lark-cli/config.json', 'user-token')
    await shell.write('~/.lark-cli/config.json', 'platform-inject')

    expect(await readFile(join(home, '.lark-cli/config.json'), 'utf8')).toBe('user-token')
  })

  it('allowHome=false 时写 HOME 直接报错；越界读返回 null', async () => {
    const root = await mkdtemp(join(tmpdir(), 'billy-host-root-'))
    cleanupDirs.push(root)
    const shell = createHostShell(root, async () => ok)

    await expect(shell.write('~/.bashrc', 'x')).rejects.toThrow('初始化只允许写工作区内')
    expect(await shell.read('../outside.txt')).toBeNull()
  })

  it('host 写工作区文件也是 0o600（权限位值，不是十进制 600）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'billy-host-root-'))
    cleanupDirs.push(root)
    const shell = createHostShell(root, async () => ok)

    await shell.write('.agents/demo/SKILL.md', '# demo')

    expect((await stat(join(root, '.agents/demo/SKILL.md'))).mode & 0o777).toBe(0o600)
  })
})
