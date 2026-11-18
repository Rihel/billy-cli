import { describe, expect, it, vi } from 'vitest'
import type { ToolInvokeRequest } from '@repo/contracts'
import { TaskManager } from '../src/task.manager.js'
import type { ToolWorkerService } from '../src/worker.service.js'

const request = (): ToolInvokeRequest => ({
  version: 1,
  requestId: 'req-1',
  toolKey: 'bash',
  toolCallId: null,
  input: { command: 'sleep 1' },
  caller: {
    conversationId: 'c-1',
    runId: 'r-1',
    userId: 'u-1',
    agentKey: 'assistant',
    rootAgentKey: 'assistant',
    depth: 0,
  },
  deadlineMs: 60_000,
})

const build = (delayMs: number, outcome: unknown = { ok: true, data: { stdout: 'done' } }) => {
  const execute = vi
    .fn()
    .mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve(outcome), delayMs)))
  return { manager: new TaskManager({ execute } as unknown as ToolWorkerService), execute }
}

describe('TaskManager：长耗时执行', () => {
  it('yield 窗口内没跑完就交回句柄，之后能查到结果', async () => {
    const { manager } = build(30)
    const accepted = await manager.start(request(), 5)
    expect(accepted.state).toBe('running')
    if (accepted.state !== 'running') throw new Error('expected running')

    const done = await manager.get(accepted.id, 100)
    expect(done.state).toBe('succeeded')
    expect(done.result).toEqual({ ok: true, data: { stdout: 'done' } })
  })

  it('窗口内跑完就直接返回结果', async () => {
    const { manager } = build(1)
    const accepted = await manager.start(request(), 100)
    expect(accepted.state).toBe('succeeded')
    expect(accepted.result).toEqual({ ok: true, data: { stdout: 'done' } })
  })

  it('取消幂等：终态返回当前快照', async () => {
    const { manager } = build(30)
    const accepted = await manager.start(request(), 1)
    const canceled = await manager.cancel(accepted.id)
    expect(canceled.state).toBe('canceled')
    const again = await manager.cancel(accepted.id)
    expect(again.state).toBe('canceled')
  })

  it('不存在的任务按 expired 处理', async () => {
    const { manager } = build(1)
    expect(await manager.get('nope')).toMatchObject({ state: 'expired' })
    expect(await manager.cancel('nope')).toMatchObject({ state: 'expired' })
  })

  it('执行器失败翻译成 failed + error', async () => {
    const { manager } = build(1, {
      ok: false,
      reason: 'sandbox-unavailable',
      message: '沙箱不可用',
    })
    const done = await manager.start(request(), 100)
    expect(done.state).toBe('failed')
    expect(done.error).toMatchObject({ reason: 'sandbox-unavailable' })
  })
})
