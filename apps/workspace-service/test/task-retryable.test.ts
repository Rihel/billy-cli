import { describe, expect, it, vi } from 'vitest'
import { WorkspaceTaskManager } from '../src/capabilities/task.manager.js'

/**
 * task 形态的暂态语义（issue 11）。
 *
 * bash 是唯一走 task 的能力：执行器的 `retryable` 必须先落进任务快照，
 * 控制器才能把它回给模型。修复前快照只有 reason / message，控制器硬编码 false。
 */

const request = {
  toolKey: 'bash',
  input: { command: 'lark-cli im send' },
  caller: {
    conversationId: 'c_1',
    runId: 'r_1',
    userId: 'u_1',
    agentKey: 'main',
    rootAgentKey: 'main',
    depth: 0,
  },
  deadlineMs: 1_000,
} as never

describe('task 快照透传 retryable', () => {
  it('执行器的暂态拒绝进快照（缺凭据正在补偿）', async () => {
    const bash = {
      bash: vi.fn(async () => ({
        ok: false,
        reason: 'missing-credential',
        message: '凭据正在自动重试',
        retryable: true,
      })),
    }
    const manager = new WorkspaceTaskManager(bash as never)

    const snapshot = await manager.start(request, 50)

    expect(snapshot.state).toBe('failed')
    expect(snapshot.error).toMatchObject({ reason: 'missing-credential', retryable: true })
  })

  it('执行器抛错 → retryable=false（我们写错了，重试没意义）', async () => {
    const bash = {
      bash: vi.fn(async () => {
        throw new Error('boom')
      }),
    }
    const manager = new WorkspaceTaskManager(bash as never)

    const snapshot = await manager.start(request, 50)

    expect(snapshot.error).toMatchObject({ reason: 'executor-error', retryable: false })
  })

  it('成功快照不带 error（不受新增字段影响）', async () => {
    const bash = { bash: vi.fn(async () => ({ ok: true, data: { stdout: 'ok' } })) }
    const manager = new WorkspaceTaskManager(bash as never)

    const snapshot = await manager.start(request, 50)

    expect(snapshot.state).toBe('succeeded')
    expect(snapshot.error).toBeUndefined()
  })
})
