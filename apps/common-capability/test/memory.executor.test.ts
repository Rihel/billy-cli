import { describe, expect, it, vi } from 'vitest'
import type { MemoryRepository, MemoryService } from '@repo/ai-data'
import type { ToolInvokeRequest } from '@repo/contracts'
import { MemoryExecutor } from '../src/tools/memory/memory.executor.js'

const request = (over: Partial<ToolInvokeRequest> = {}): ToolInvokeRequest => ({
  version: 1,
  requestId: 'req-mem',
  toolKey: 'memory-save',
  toolCallId: 'call-mem',
  input: { content: '用户喜欢深色主题' },
  caller: {
    conversationId: 'c-1',
    runId: 'r-1',
    userId: 'u-1',
    isAdmin: false,
    agentKey: 'assistant',
    rootAgentKey: 'assistant',
    depth: 0,
  },
  deadlineMs: 10_000,
  ...over,
})

const build = () => {
  const memory = {
    saveFromTool: vi.fn(async () => ({ ok: true, memory: { id: 'm-1', memKey: 'theme' } })),
    searchFromTool: vi.fn(async () => []),
    forgetFromTool: vi.fn(async () => true),
  } as unknown as MemoryService
  return {
    executor: new MemoryExecutor(memory, {} as MemoryRepository),
    memory,
  }
}

describe('MemoryExecutor（直连 DB 数据层）', () => {
  it('memory-save 直接调 MemoryService，不经过 server', async () => {
    const { executor, memory } = build()
    const outcome = await executor.memorySave(request())
    expect(outcome).toEqual({ ok: true, data: { saved: true, id: 'm-1', key: 'theme' } })
    expect(memory.saveFromTool).toHaveBeenCalledWith('u-1', 'assistant', {
      content: '用户喜欢深色主题',
    })
  })

  it('没有用户身份时拒绝', async () => {
    const { executor } = build()
    const outcome = await executor.memorySave(
      request({ caller: { ...request().caller, userId: null } }),
    )
    expect(outcome).toMatchObject({ ok: false, reason: 'forbidden' })
  })
})
