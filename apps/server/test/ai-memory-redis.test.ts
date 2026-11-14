import { Redis } from 'ioredis'
import { describe, expect, it } from 'vitest'
import { createAgentMemory } from '../src/modules/ai/mastra/agent-memory.js'

/**
 * 短期记忆落 Redis 的集成测试（设计 `docs/design/ai-memory.md` §4.1）。
 *
 * 验证的是**换一个实例还能读到**——这正是重启 / 换副本的场景；不依赖模型与数据库。
 */
const url = process.env.REDIS_URL ?? 'redis://localhost:6379/0'

const threadId = (): string =>
  `test-memory-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`

const closeMemory = async (memory: ReturnType<typeof createAgentMemory>): Promise<void> => {
  const storage = (memory as unknown as { storage?: { close?: () => Promise<void> } }).storage
  await storage?.close?.()
}

const cleanKeys = async (pattern: string): Promise<void> => {
  const redis = new Redis(url)
  try {
    const keys: string[] = []
    for await (const batch of redis.scanStream({ match: pattern, count: 100 })) {
      keys.push(...(batch as string[]))
    }
    if (keys.length > 0) await redis.del(...keys)
  } finally {
    await redis.quit()
  }
}

describe('短期记忆（@mastra/redis）', () => {
  it('一个实例写入，另一个实例能读到同一条 thread 的消息', async () => {
    const id = threadId()
    const writer = createAgentMemory(url)
    const reader = createAgentMemory(url)
    try {
      await writer.createThread({ threadId: id, resourceId: 'user-test' })
      await writer.saveMessages({
        messages: [
          {
            id: `${id}-m1`,
            threadId: id,
            resourceId: 'user-test',
            role: 'user',
            createdAt: new Date(),
            content: { format: 2, parts: [{ type: 'text', text: '跨实例持久化' }] },
          },
        ] as never,
      })

      const recalled = await reader.recall({ threadId: id, perPage: 10 })
      expect(recalled.messages).toHaveLength(1)
      expect(JSON.stringify(recalled.messages[0]?.content)).toContain('跨实例持久化')
    } finally {
      await closeMemory(writer)
      await closeMemory(reader)
      await cleanKeys(`*${id}*`)
    }
  }, 20_000)
})
