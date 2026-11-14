import { describe, expect, it, vi } from 'vitest'
import {
  isThreadExpired,
  MemoryThreadCleanupService,
} from '../src/modules/ai/memory/memory-thread-cleanup.service.js'
import { silentLogger } from './helpers/ai-tool-stack.js'

/**
 * thread 清理（设计 `docs/design/ai-memory.md` §4.3）。
 *
 * 只测"该不该删 / 删了哪些"：用假 Redis 的 SCAN 流，不碰真实实例。
 */
const DAY = 86_400_000

const makeRedis = (threads: Record<string, unknown>, messageKeys: string[] = []) => {
  const allKeys = [...Object.keys(threads), ...messageKeys]
  const scanStream = (options: { match: string }) => ({
    async *[Symbol.asyncIterator]() {
      const prefix = options.match.replace(/\*$/, '')
      yield allKeys.filter((key) => key.startsWith(prefix))
    },
  })
  return {
    acquireLock: vi.fn(async () => 'lock-token'),
    releaseLock: vi.fn(async () => true),
    get: vi.fn(async (key: string) => {
      const value = threads[key]
      return value === undefined ? null : JSON.stringify(value)
    }),
    del: vi.fn(async (...keys: string[]) => keys.length),
    raw: { scanStream },
  }
}

const makeService = (redis: ReturnType<typeof makeRedis>): MemoryThreadCleanupService =>
  new MemoryThreadCleanupService(
    { scheduleCron: vi.fn() } as never,
    redis as never,
    silentLogger as never,
  )

describe('isThreadExpired', () => {
  const now = Date.parse('2026-11-14T00:00:00Z')

  it('超过 TTL 才过期', () => {
    expect(isThreadExpired(new Date(now - 31 * DAY).toISOString(), now)).toBe(true)
    expect(isThreadExpired(new Date(now - 29 * DAY).toISOString(), now)).toBe(false)
  })

  it('非法 createdAt 不删（宁可留着也别误删）', () => {
    expect(isThreadExpired(undefined, now)).toBe(false)
    expect(isThreadExpired('not-a-date', now)).toBe(false)
  })
})

describe('MemoryThreadCleanupService', () => {
  const now = Date.parse('2026-11-14T00:00:00Z')

  it('只删过期的 thread，并连同它的消息一起删', async () => {
    const redis = makeRedis(
      {
        'mastra_threads:id:old': { createdAt: new Date(now - 40 * DAY).toISOString() },
        'mastra_threads:id:fresh': { createdAt: new Date(now - 1 * DAY).toISOString() },
      },
      ['mastra_messages:threadId:old:1', 'mastra_messages:threadId:fresh:1'],
    )

    const removed = await makeService(redis).run(now)

    expect(removed).toBe(1)
    expect(redis.del).toHaveBeenCalledWith('mastra_messages:threadId:old:1')
    expect(redis.del).toHaveBeenCalledWith('mastra_threads:id:old')
    expect(redis.del).not.toHaveBeenCalledWith('mastra_threads:id:fresh')
    expect(redis.releaseLock).toHaveBeenCalled()
  })

  it('拿不到锁就跳过（多实例只跑一个）', async () => {
    const redis = makeRedis({})
    redis.acquireLock.mockResolvedValueOnce(null)

    expect(await makeService(redis).run(now)).toBe(0)
    expect(redis.del).not.toHaveBeenCalled()
  })
})
