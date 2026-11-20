import { describe, expect, it, vi } from 'vitest'
import { BashExecutor } from '../src/capabilities/bash.executor.js'

/**
 * `bash` 的执行前检查接线（§6.4.4）：命中缺凭据 → 直接拒绝，**不执行命令**。
 */

const make = (denial: unknown) => {
  const exec = vi.fn(async () => ({
    ok: true,
    exitCode: 0,
    stdout: 'done',
    stderr: '',
    durationMs: 1,
    runtime: 'sandbox' as const,
  }))
  const executor = new BashExecutor(
    { authorizeCommand: vi.fn(async () => denial), exec } as never,
    { workspaceIdOf: vi.fn(async () => 'ws_1') } as never,
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
    const { executor, exec } = make({ provider: 'github', label: 'GitHub', reason: 'missing' })

    const outcome = await executor.bash(request('gh pr list'))

    expect(outcome).toMatchObject({ ok: false, reason: 'missing-credential', retryable: false })
    expect(String(outcome.message)).toContain('GitHub')
    expect(exec).not.toHaveBeenCalled()
  })

  it('检查通过 → 正常执行', async () => {
    const { executor, exec } = make(null)

    const outcome = await executor.bash(request('echo hi'))

    expect(outcome.ok).toBe(true)
    expect(exec).toHaveBeenCalledTimes(1)
  })
})
