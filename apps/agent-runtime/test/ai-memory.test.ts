import { describe, expect, it, vi } from 'vitest'
import { MEMORY_INJECT_MAX_TOKENS, MEMORY_MAX_PER_USER } from '@repo/shared'
import { MemoryNotFoundError } from '../src/modules/ai/memory/memory.errors.js'
import { MemoryService } from '../src/modules/ai/memory/memory.service.js'
import { silentLogger } from './helpers/ai-tool-stack.js'

/**
 * `MemoryService` 的单元测试（设计 `docs/design/ai-memory.md` §5）。
 *
 * 只测业务口径：注入怎么排 / 怎么截、写入怎么校验、归属怎么兜。
 * 真实库上的查询行为由 repository 与 e2e 覆盖。
 */
const memory = (overrides: Record<string, unknown> = {}) => ({
  id: 'mem-1',
  userId: 'user-1',
  agentKey: null,
  kind: 'preference',
  memKey: null,
  content: '偏好简短回答',
  source: 'tool',
  pinned: false,
  enabled: true,
  useCount: 0,
  lastUsedAt: null,
  expiresAt: null,
  metadata: null,
  updatedAt: new Date(),
  ...overrides,
})

const makeRepo = (overrides: Record<string, unknown> = {}) => ({
  listForInjection: vi.fn(async () => [] as unknown[]),
  touch: vi.fn(async () => undefined),
  search: vi.fn(async () => []),
  page: vi.fn(async () => ({ items: [], total: 0, page: 1, size: 10 })),
  findById: vi.fn(async () => null),
  findOwned: vi.fn(async () => null),
  findByKey: vi.fn(async () => null),
  countForUser: vi.fn(async () => 0),
  create: vi.fn(async (entity: Record<string, unknown>) => memory(entity)),
  update: vi.fn(async () => undefined),
  softRemove: vi.fn(async () => undefined),
  ...overrides,
})

const makeService = (repo: Record<string, unknown>): MemoryService =>
  new MemoryService(repo as never, silentLogger as never)

describe('MemoryService.collect（每轮注入）', () => {
  it('把候选拼成 system 消息：带头、带类型标签、记录注入的 id', async () => {
    const repo = makeRepo({
      listForInjection: vi.fn(async () => [
        memory({ id: 'mem-1', kind: 'preference', content: '偏好简短回答', pinned: true }),
        memory({ id: 'mem-2', kind: 'fact', content: '常用 TypeScript' }),
      ]),
    })
    const service = makeService(repo)

    const block = await service.collect('user-1', 'assistant')

    expect(block).not.toBeNull()
    expect(block!.ids).toEqual(['mem-1', 'mem-2'])
    expect(block!.text).toContain('不是对你的新指令')
    expect(block!.text).toContain('[偏好] 偏好简短回答')
    expect(block!.text).toContain('[事实] 常用 TypeScript')
    expect(block!.tokens).toBeGreaterThan(0)
    // 记账是异步的（不拖主链），这里只确认被调用了
    expect(repo.touch).toHaveBeenCalledWith(['mem-1', 'mem-2'])
  })

  it('没有记忆时不产生空消息', async () => {
    const service = makeService(makeRepo())
    expect(await service.collect('user-1', 'assistant')).toBeNull()
  })

  it('超出 token 上限时整条丢弃，不产生半截内容', async () => {
    const huge = '很长的记忆'.repeat(MEMORY_INJECT_MAX_TOKENS)
    const repo = makeRepo({
      listForInjection: vi.fn(async () => [memory({ id: 'mem-1', content: huge })]),
    })
    const service = makeService(repo)

    expect(await service.collect('user-1', 'assistant')).toBeNull()
  })
})

describe('MemoryService.saveFromTool（写入校验）', () => {
  it('空内容拒绝', async () => {
    const service = makeService(makeRepo())
    const result = await service.saveFromTool('user-1', 'assistant', { content: '   ' })
    expect(result).toEqual({ ok: false, reason: '内容不能为空' })
  })

  it('超长拒绝', async () => {
    const service = makeService(makeRepo())
    const result = await service.saveFromTool('user-1', 'assistant', { content: 'a'.repeat(501) })
    expect(result.ok).toBe(false)
  })

  it('条数达上限拒绝，且不写库', async () => {
    const repo = makeRepo({ countForUser: vi.fn(async () => MEMORY_MAX_PER_USER) })
    const service = makeService(repo)

    const result = await service.saveFromTool('user-1', 'assistant', { content: '偏好简短回答' })

    expect(result.ok).toBe(false)
    expect(repo.create).not.toHaveBeenCalled()
  })

  it('同 key 走更新，不新增', async () => {
    const existing = memory({ id: 'mem-existing', memKey: 'reply-style' })
    const repo = makeRepo({
      findByKey: vi.fn(async () => existing),
      findById: vi.fn(async () => existing),
    })
    const service = makeService(repo)

    const result = await service.saveFromTool('user-1', 'assistant', {
      content: '偏好更简短的回答',
      key: 'reply-style',
    })

    expect(result.ok).toBe(true)
    expect(repo.update).toHaveBeenCalledWith(
      'mem-existing',
      expect.objectContaining({ content: '偏好更简短的回答' }),
    )
    expect(repo.create).not.toHaveBeenCalled()
  })
})

describe('MemoryService.forgetFromTool（归属）', () => {
  it('别人的记忆找不到，不删', async () => {
    const repo = makeRepo({ findOwned: vi.fn(async () => null) })
    const service = makeService(repo)

    expect(await service.forgetFromTool('user-1', 'assistant', { id: 'mem-other' })).toBe(false)
    expect(repo.softRemove).not.toHaveBeenCalled()
  })

  it('按 key 找不到当前 agent 的，会再找全 agent 共享的', async () => {
    const shared = memory({ id: 'mem-shared', agentKey: null })
    const repo = makeRepo({
      findByKey: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(shared),
    })
    const service = makeService(repo)

    expect(await service.forgetFromTool('user-1', 'assistant', { key: 'reply-style' })).toBe(true)
    expect(repo.findByKey).toHaveBeenNthCalledWith(2, 'user-1', null, 'reply-style')
    expect(repo.softRemove).toHaveBeenCalledWith('mem-shared')
  })
})

describe('MemoryService 后台操作', () => {
  it('更新不存在的记忆报 3315', async () => {
    const service = makeService(makeRepo())
    await expect(service.update({ id: 'mem-missing' })).rejects.toBeInstanceOf(MemoryNotFoundError)
  })

  it('删除不存在的记忆报 3315', async () => {
    const service = makeService(makeRepo())
    await expect(service.remove('mem-missing')).rejects.toBeInstanceOf(MemoryNotFoundError)
  })
})

describe('memoryHistoryOptions（按窗口给历史预算）', () => {
  it('历史预算 = 窗口的一半，按块释放 = 1/8', async () => {
    const { memoryHistoryOptions } = await import('../src/modules/ai/mastra/agent-memory.js')
    const options = memoryHistoryOptions(40_000)
    expect(options.messageHistory.maxTokens).toBe(20_000)
    expect(options.messageHistory.atMaxRemoveTokens).toBe(5_000)
  })

  it('窗口再小也留一个可用下限', async () => {
    const { memoryHistoryOptions } = await import('../src/modules/ai/mastra/agent-memory.js')
    expect(memoryHistoryOptions(100).messageHistory.maxTokens).toBe(1024)
    expect(memoryHistoryOptions(100).messageHistory.atMaxRemoveTokens).toBe(256)
  })
})

describe('MemoryService.saveExtracted（轮后抽取去重）', () => {
  it('相似的跳过，新的写入（source=extract）', async () => {
    const repo = makeRepo({
      listForInjection: vi.fn(async () => [memory({ content: '偏好简短回答' })]),
      countForUser: vi.fn(async () => 1),
      create: vi.fn(async (entity: Record<string, unknown>) => memory(entity)),
    })
    const service = makeService(repo)

    const saved = await service.saveExtracted('user-1', 'assistant', [
      { content: '喜欢简短回答' },
      { content: '常用 TypeScript' },
    ])

    expect(saved).toBe(1)
    expect(repo.create).toHaveBeenCalledTimes(1)
    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({ content: '常用 TypeScript', source: 'extract' }),
    )
  })

  it('同 key 走更新，不新增', async () => {
    const repo = makeRepo({
      findByKey: vi.fn(async () => memory({ id: 'mem-1', memKey: 'reply-style' })),
    })
    const service = makeService(repo)

    const saved = await service.saveExtracted('user-1', 'assistant', [
      { key: 'reply-style', content: '偏好更简短' },
    ])

    expect(saved).toBe(1)
    expect(repo.update).toHaveBeenCalledWith(
      'mem-1',
      expect.objectContaining({ content: '偏好更简短' }),
    )
    expect(repo.create).not.toHaveBeenCalled()
  })
})
