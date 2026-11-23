import { describe, expect, it, vi } from 'vitest'
import { BashExecutor } from '../src/capabilities/bash.executor.js'

/**
 * `bash` 的执行前检查接线（§6.4.4）：命中缺凭据 → 直接拒绝，**不执行命令**。
 */

const make = (gate: unknown) => {
  const exec = vi.fn(async () => ({
    ok: true,
    exitCode: 0,
    stdout: 'done',
    stderr: '',
    durationMs: 1,
    runtime: 'sandbox' as const,
  }))
  const executor = new BashExecutor(
    { authorizeCommand: vi.fn(async () => gate), exec } as never,
    {
      workspaceIdOf: vi.fn(async () => 'ws_1'),
      resolve: vi.fn(async () => ({ workspaceId: 'ws_1', workdir: null })),
    } as never,
  )
  return { executor, exec }
}

const request = (command: string) =>
  ({
    input: { command },
    caller: {
      conversationId: 'c_1',
      runId: 'r_1',
      userId: 'u_1',
      agentKey: 'main',
      rootAgentKey: 'main',
      depth: 0,
    },
    deadlineMs: 10_000,
  }) as never

describe('bash 执行前检查', () => {
  it('缺凭据时返回 missing-credential，且命令不执行', async () => {
    const { executor, exec } = make({
      denial: { provider: 'github', label: 'GitHub', reason: 'missing' },
      transient: false,
    })

    const outcome = await executor.bash(request('gh pr list'))

    expect(outcome).toMatchObject({ ok: false, reason: 'missing-credential', retryable: false })
    expect(String(outcome.message)).toContain('GitHub')
    expect(exec).not.toHaveBeenCalled()
  })

  it('暂态拒绝（凭据正在补偿）→ retryable 且引导重试，不当成永久失败', async () => {
    const { executor, exec } = make({
      denial: { provider: 'lark', label: '飞书（Lark）', reason: 'missing' },
      transient: true,
    })

    const outcome = await executor.bash(request('lark-cli im send'))

    expect(outcome).toMatchObject({ ok: false, reason: 'missing-credential', retryable: true })
    expect(String(outcome.message)).toContain('自动重试')
    expect(outcome.ok === false ? outcome.hint : '').toContain('暂态')
    expect(exec).not.toHaveBeenCalled()
  })

  it('会话 workdir：先建目录，默认 cwd 指向会话目录', async () => {
    const exec = vi.fn(async () => ({
      ok: true,
      exitCode: 0,
      stdout: 'done',
      stderr: '',
      durationMs: 1,
      runtime: 'sandbox' as const,
    }))
    const fs = vi.fn(async () => ({ ok: true, data: {} }))
    const executor = new BashExecutor(
      { authorizeCommand: vi.fn(async () => null), exec, fs } as never,
      {
        resolve: vi.fn(async () => ({ workspaceId: 'ws_1', workdir: 'conversations/c1' })),
      } as never,
    )

    const outcome = await executor.bash(request('echo hi'))

    expect(outcome.ok).toBe(true)
    expect(fs).toHaveBeenCalledWith('ws_1', {
      workspaceId: 'ws_1',
      op: 'mkdir',
      path: 'conversations/c1',
    })
    expect(exec).toHaveBeenCalledWith('ws_1', expect.objectContaining({ cwd: 'conversations/c1' }))
  })

  it('检查通过 → 正常执行', async () => {
    const { executor, exec } = make(null)

    const outcome = await executor.bash(request('echo hi'))

    expect(outcome.ok).toBe(true)
    expect(exec).toHaveBeenCalledTimes(1)
  })
})
