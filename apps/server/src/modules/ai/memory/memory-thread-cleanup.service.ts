import { Inject, Injectable, type OnApplicationBootstrap } from '@nestjs/common'
import { AppLogger, RedisStore, Scheduler } from '@repo/kits'
import { MEMORY_THREAD_TTL_DAYS } from '@repo/shared'

/** 是否为"该清掉"的 thread（纯函数，便于单测） */
export const isThreadExpired = (
  createdAt: unknown,
  nowMs: number,
  ttlDays = MEMORY_THREAD_TTL_DAYS,
): boolean => {
  if (typeof createdAt !== 'string' && !(createdAt instanceof Date)) return false
  const time = new Date(createdAt).getTime()
  if (!Number.isFinite(time)) return false
  return time < nowMs - ttlDays * 86_400_000
}

/** `@mastra/redis` 的键布局（官方文档给的结构；清理只按这两个前缀扫） */
const THREAD_KEY_PREFIX = 'mastra_threads:id:'
const MESSAGE_KEY_PREFIX = 'mastra_messages:threadId:'

/**
 * 短期记忆 thread 的过期清理（设计 `docs/design/ai-memory.md` §4.3）。
 *
 * 为什么需要它：`@mastra/redis` 不提供 TTL，thread 会一直增长；而 thread 只是缓存，
 * 过期的会话本来就不该再占 Redis。
 *
 * 三条口径：
 * - **按 thread 的 `createdAt` 判断**（不是 `updatedAt`）：静置很久的会话整体清掉，
 *   正在聊的会话由用户继续产生新消息、`createdAt` 不会被动到 —— 这里刻意选保守的一侧；
 * - **先删消息再删 thread**：中途失败最多留下"孤儿消息"，下一轮扫描能补删；
 * - **多实例只跑一个**：Redis 锁；拿不到锁就跳过，不排队。
 */
@Injectable()
export class MemoryThreadCleanupService implements OnApplicationBootstrap {
  constructor(
    @Inject(Scheduler) private readonly scheduler: Scheduler,
    @Inject(RedisStore) private readonly redis: RedisStore,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}

  onApplicationBootstrap(): void {
    // 每天 04:17（避开整点任务）；protect 保证同一实例不重入，跨实例靠下面的锁
    this.scheduler.scheduleCron(
      'ai-memory-thread-cleanup',
      '17 4 * * *',
      () => this.run().then(() => undefined),
      {
        protect: true,
        timezone: 'Asia/Shanghai',
      },
    )
  }

  /** 供测试与手动触发；返回删掉的 thread 数 */
  async run(now = Date.now()): Promise<number> {
    const lock = 'ai:memory:thread-cleanup'
    const token = await this.redis.acquireLock(lock, 600)
    if (!token) return 0
    try {
      const threadKeys = await this.scan(THREAD_KEY_PREFIX)
      let removed = 0
      for (const key of threadKeys) {
        const threadId = key.slice(THREAD_KEY_PREFIX.length)
        if (!threadId) continue
        const raw = await this.redis.get(key)
        if (!raw) continue
        let createdAt: unknown
        try {
          createdAt = (JSON.parse(raw) as { createdAt?: unknown }).createdAt
        } catch {
          continue // 不是我们认识的 thread（别误删）
        }
        if (!isThreadExpired(createdAt, now)) continue

        const messageKeys = await this.scan(`${MESSAGE_KEY_PREFIX}${threadId}:`)
        if (messageKeys.length > 0) await this.redis.del(...messageKeys)
        await this.redis.del(key)
        removed += 1
      }
      this.logger.log('ai.memory.thread_cleanup', {
        scanned: threadKeys.length,
        removed,
        ttlDays: MEMORY_THREAD_TTL_DAYS,
      })
      return removed
    } catch (error) {
      // 定时任务不能因为一次失败把循环打断（Scheduler 也会兜，但这里要留痕）
      this.logger.error('ai.memory.thread_cleanup_failed', { error })
      return 0
    } finally {
      await this.redis.releaseLock(lock, token)
    }
  }

  /** SCAN（不用 KEYS：单线程 Redis 上 KEYS 会卡住所有请求） */
  private async scan(prefix: string): Promise<string[]> {
    const stream = this.redis.raw.scanStream({ match: `${prefix}*`, count: 200 })
    const keys: string[] = []
    for await (const batch of stream) {
      if (Array.isArray(batch)) keys.push(...(batch as string[]))
    }
    return keys
  }
}
