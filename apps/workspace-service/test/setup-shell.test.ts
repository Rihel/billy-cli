import { describe, expect, it } from 'vitest'
import { createExecShell, type SetupExecResult } from '../src/workspace/setup/shell.js'

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
