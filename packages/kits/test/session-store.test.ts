import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { RedisStore } from '../src/redis/redis-store.js'
import type { JwtConfig } from '../src/jwt/jwt.config.js'
import { IdGeneration } from '../src/foundation/id-generation/id-generation.js'
import { SessionStore } from '../src/session/session-store.js'

interface Entry {
  value: string
  expiresAt: number | null
}

/**
 * 最小 RedisStore 替身：只实现 SessionStore 用到的命令。
 *
 * 两个关键点：
 * - **Set 也是 key**（真实 Redis 里一样有 TTL）—— 只用 Map 存集合会让 `expire(indexKey)`
 *   失效，测不出「索引与会话同时到期」；
 * - 时间统一取 `Date.now()`（**不引入内部时钟**）—— 被测代码用的是真实时钟，
 *   替身若自有计时器就会与它错位（曾因此让「节流写回」用例假失败）。
 *   需要「61s 前的活跃」这类场景，直接改写会话负载里的时间字段。
 */
class FakeRedisStore {
  private data = new Map<string, Entry>()
  private sets = new Map<string, Set<string>>()
  private setExpiry = new Map<string, number | null>()

  /** 模拟 session key 因 TTL 到期自然消失（索引里的成员成为残留） */
  evict(key: string): void {
    this.data.delete(key)
  }

  /** 直接写入原始字符串（构造「升级前登记的旧会话」用） */
  put(key: string, value: string, ttlSeconds?: number): void {
    this.data.set(key, {
      value,
      expiresAt: ttlSeconds === undefined ? null : Date.now() + ttlSeconds * 1000,
    })
  }

  /** 改写会话负载的字段（构造时间相关场景，见文件头说明） */
  patchSession(token: string, patch: Record<string, unknown>): void {
    const key = sessionKey(token)
    const payload = JSON.parse(this.rawValue(key) ?? '{}') as Record<string, unknown>
    const ttl = this.data.get(key)?.expiresAt
    this.put(
      key,
      JSON.stringify({ ...payload, ...patch }),
      ttl === null || ttl === undefined ? undefined : Math.max(1, Math.ceil((ttl - Date.now()) / 1000)),
    )
  }

  rawValue(key: string): string | undefined {
    const entry = this.data.get(key)
    if (!entry) return undefined
    if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
      this.data.delete(key)
      return undefined
    }
    return entry.value
  }

  setMembers(key: string): string[] {
    const expiresAt = this.setExpiry.get(key)
    if (expiresAt !== undefined && expiresAt !== null && expiresAt <= Date.now()) {
      this.sets.delete(key)
      this.setExpiry.delete(key)
      return []
    }
    return [...(this.sets.get(key) ?? [])]
  }

  has(key: string): boolean {
    return this.rawValue(key) !== undefined || this.setMembers(key).length > 0
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<string | null> {
    this.put(key, value, ttlSeconds)
    return 'OK'
  }

  async setJson<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    this.put(key, JSON.stringify(value), ttlSeconds)
  }

  async getJson<T>(key: string): Promise<T | null> {
    const value = this.rawValue(key)
    return value === undefined ? null : (JSON.parse(value) as T)
  }

  async del(...keys: string[]): Promise<number> {
    let removed = 0
    for (const key of keys) {
      if (this.data.delete(key)) removed += 1
      if (this.sets.delete(key)) removed += 1
      this.setExpiry.delete(key)
    }
    return removed
  }

  async expire(key: string, seconds: number): Promise<boolean> {
    const entry = this.data.get(key)
    if (entry) {
      entry.expiresAt = Date.now() + seconds * 1000
      return true
    }
    if (this.sets.has(key)) {
      this.setExpiry.set(key, Date.now() + seconds * 1000)
      return true
    }
    return false
  }

  async ttl(key: string): Promise<number> {
    const expiresAt = this.data.get(key)?.expiresAt ?? this.setExpiry.get(key)
    if (expiresAt === undefined) return -2
    if (expiresAt === null) return -1
    return Math.ceil((expiresAt - Date.now()) / 1000)
  }

  raw = {
    get: async (key: string): Promise<string | null> => this.rawValue(key) ?? null,
    sadd: async (key: string, ...members: string[]): Promise<number> => {
      const set = this.sets.get(key) ?? new Set<string>()
      let added = 0
      for (const member of members) {
        if (!set.has(member)) added += 1
        set.add(member)
      }
      this.sets.set(key, set)
      return added
    },
    srem: async (key: string, ...members: string[]): Promise<number> => {
      const set = this.sets.get(key)
      if (!set) return 0
      let removed = 0
      for (const member of members) {
        if (set.delete(member)) removed += 1
      }
      return removed
    },
    smembers: async (key: string): Promise<string[]> => this.setMembers(key),
  }
}

const TOKEN = 'jwt-token-a'
const OTHER_TOKEN = 'jwt-token-b'
const sha = (token: string) => createHash('sha256').update(token).digest('hex')
const sessionKey = (token: string) => `auth:session:${sha(token)}`
const indexKey = (type: string, sub: string) => `auth:index:${type}:${sub}`
const sidKeyOf = (type: string, sub: string, sessionId: string) =>
  `auth:sid:${type}:${sub}:${sessionId}`

const SEVEN_DAYS = 7 * 24 * 60 * 60

/**
 * 等 `verify()` 里 fire-and-forget 的 lastSeenAt 写回落地。
 * 替身的方法都是「立即 resolve 的 async」，几轮微任务足够（不打桩计时器）。
 */
const flushMicrotasks = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve()
}

const makeStore = () => {
  const redis = new FakeRedisStore()
  const store = new SessionStore(
    { expiresIn: '7d' } as JwtConfig,
    redis as unknown as RedisStore,
    new IdGeneration(),
  )
  return { store, redis }
}

describe('SessionStore（会话存储：元数据 + 列表 + 单设备下线）', () => {
  it('create：写会话负载 + 反查 key + 索引，并给索引设与会话相同的 TTL', async () => {
    const { store, redis } = makeStore()

    await store.create(TOKEN, { sub: 'u-1', type: 'user' }, { ip: '10.0.0.1', userAgent: 'UA/1' })

    const payload = JSON.parse(redis.rawValue(sessionKey(TOKEN)) ?? '{}') as Record<string, unknown>
    expect(payload).toMatchObject({
      sub: 'u-1',
      type: 'user',
      ip: '10.0.0.1',
      userAgent: 'UA/1',
    })
    expect(typeof payload.sessionId).toBe('string')
    expect((payload.sessionId as string).length).toBe(24)
    expect(payload.createdAt).toBe(payload.lastSeenAt)

    // 反查 key → sha，供单设备下线 O(1) 定位
    expect(redis.rawValue(sidKeyOf('user', 'u-1', payload.sessionId as string))).toBe(sha(TOKEN))
    // 索引成员 = sha，且索引有 TTL（与会话一致，避免索引比会话长寿）
    expect(redis.setMembers(indexKey('user', 'u-1'))).toEqual([sha(TOKEN)])
    expect(await redis.ttl(indexKey('user', 'u-1'))).toBe(SEVEN_DAYS)
  })

  it('verify：已登记会话返回主体；未登记 / 已撤销返回 null', async () => {
    const { store } = makeStore()
    await store.create(TOKEN, { sub: 'u-1', type: 'user' })

    await expect(store.verify(TOKEN)).resolves.toMatchObject({ sub: 'u-1', type: 'user' })
    await expect(store.verify('unknown-token')).resolves.toBeNull()

    await store.revoke(TOKEN)
    await expect(store.verify(TOKEN)).resolves.toBeNull()
  })

  it('verify：lastSeenAt 按 60s 节流写回，且写回不延长会话寿命', async () => {
    const { store, redis } = makeStore()
    await store.create(TOKEN, { sub: 'u-1', type: 'user' })

    const before = JSON.parse(redis.rawValue(sessionKey(TOKEN)) ?? '{}') as { lastSeenAt: number }

    // 刚活跃过（< 60s）：节流，不写回
    await store.verify(TOKEN)
    await flushMicrotasks()
    const throttled = JSON.parse(redis.rawValue(sessionKey(TOKEN)) ?? '{}') as { lastSeenAt: number }
    expect(throttled.lastSeenAt).toBe(before.lastSeenAt)

    // 上一次活跃在 61s 前，且会话只剩 120s 寿命
    const staleSeenAt = Date.now() - 61_000
    const expiresAt = Date.now() + 120_000
    redis.patchSession(TOKEN, { lastSeenAt: staleSeenAt, expiresAt })
    await store.verify(TOKEN)
    await flushMicrotasks()

    const touched = JSON.parse(redis.rawValue(sessionKey(TOKEN)) ?? '{}') as { lastSeenAt: number }
    // 陈旧的 lastSeenAt 被刷新（与创建同毫秒时会相等，故与 61s 前的旧值比较）
    expect(touched.lastSeenAt).toBeGreaterThan(staleSeenAt)
    expect(touched.lastSeenAt).toBeLessThanOrEqual(Date.now())

    // 写回用的是「剩余寿命」而不是完整 TTL：否则每活跃一次就把会话续命 7 天
    const ttl = await redis.ttl(sessionKey(TOKEN))
    expect(ttl).toBeLessThanOrEqual(120)
    expect(ttl).toBeGreaterThan(0)
  })

  it('list：按最后活跃倒序，标出当前会话', async () => {
    const { store, redis } = makeStore()
    await store.create(TOKEN, { sub: 'u-1', type: 'user' }, { userAgent: 'first' })
    await store.create(OTHER_TOKEN, { sub: 'u-1', type: 'user' }, { userAgent: 'second' })
    // 让第一个会话「更早活跃」（同一毫秒内创建的两条记录需要显式区分先后）
    redis.patchSession(TOKEN, { lastSeenAt: Date.now() - 10_000 })

    const result = await store.list('user', 'u-1', TOKEN)

    expect(result.entries).toHaveLength(2)
    // 后活跃的在前
    expect(result.entries[0].userAgent).toBe('second')
    expect(result.entries[1].userAgent).toBe('first')
    expect(result.currentSessionId).toBe(result.entries[1].sessionId)

    const noToken = await store.list('user', 'u-1')
    expect(noToken.currentSessionId).toBeNull()
  })

  it('list：修剪已过期会话在索引里留下的残留成员', async () => {
    const { store, redis } = makeStore()
    await store.create(TOKEN, { sub: 'u-1', type: 'user' })
    await store.create(OTHER_TOKEN, { sub: 'u-1', type: 'user' })

    // 模拟 TTL 自然到期：session key 消失，索引成员还在
    redis.evict(sessionKey(OTHER_TOKEN))
    expect(redis.setMembers(indexKey('user', 'u-1'))).toHaveLength(2)

    const result = await store.list('user', 'u-1', TOKEN)

    expect(result.entries).toHaveLength(1)
    expect(redis.setMembers(indexKey('user', 'u-1'))).toEqual([sha(TOKEN)])
  })

  it('list：把升级前的旧会话（无 sessionId / 无时间）就地补全', async () => {
    const { store, redis } = makeStore()
    redis.put(sessionKey(TOKEN), JSON.stringify({ sub: 'u-1', type: 'user' }), SEVEN_DAYS)
    await redis.raw.sadd(indexKey('user', 'u-1'), sha(TOKEN))

    const result = await store.list('user', 'u-1', TOKEN)

    expect(result.entries).toHaveLength(1)
    const entry = result.entries[0]
    expect(entry.sessionId).toHaveLength(24)
    expect(entry.createdAt).toBeGreaterThan(0)
    expect(entry.current ?? true).toBe(true)
    expect(result.currentSessionId).toBe(entry.sessionId)
    // 补全后写回：负载含 sessionId + ip/userAgent 显式 null，反查 key 也建好
    expect(JSON.parse(redis.rawValue(sessionKey(TOKEN)) ?? '{}')).toMatchObject({
      sessionId: entry.sessionId,
      ip: null,
      userAgent: null,
    })
    expect(redis.rawValue(sidKeyOf('user', 'u-1', entry.sessionId))).toBe(sha(TOKEN))
  })

  it('revokeById：下线指定设备并幂等（重复调用返回 false）', async () => {
    const { store, redis } = makeStore()
    await store.create(TOKEN, { sub: 'u-1', type: 'user' })
    await store.create(OTHER_TOKEN, { sub: 'u-1', type: 'user' })
    const listed = await store.list('user', 'u-1', TOKEN)
    const other = listed.entries.find(
      (entry) => entry.sessionId !== listed.currentSessionId,
    )!

    await expect(store.revokeById('user', 'u-1', other.sessionId)).resolves.toBe(true)
    await expect(store.revokeById('user', 'u-1', other.sessionId)).resolves.toBe(false)

    // 只下线目标设备：当前会话仍在，索引与反查 key 已清
    await expect(store.verify(OTHER_TOKEN)).resolves.toBeNull()
    await expect(store.verify(TOKEN)).resolves.toMatchObject({ sub: 'u-1' })
    expect(redis.setMembers(indexKey('user', 'u-1'))).toEqual([sha(TOKEN)])
    expect(redis.has(sidKeyOf('user', 'u-1', other.sessionId))).toBe(false)
  })

  it('revokeById：他人的 sessionId 命中不了（作用域锁定 type + sub）', async () => {
    const { store } = makeStore()
    await store.create(TOKEN, { sub: 'u-1', type: 'user' })
    const { entries } = await store.list('user', 'u-1', TOKEN)

    await expect(store.revokeById('user', 'u-2', entries[0].sessionId)).resolves.toBe(false)
    await expect(store.verify(TOKEN)).resolves.toMatchObject({ sub: 'u-1' })
  })

  it('revokeAll：清空全部会话、反查 key 与索引（禁用 / 删除实体用）', async () => {
    const { store, redis } = makeStore()
    await store.create(TOKEN, { sub: 'u-1', type: 'user' })
    await store.create(OTHER_TOKEN, { sub: 'u-1', type: 'user' })
    const { entries } = await store.list('user', 'u-1', TOKEN)

    await store.revokeAll('user', 'u-1')

    await expect(store.verify(TOKEN)).resolves.toBeNull()
    await expect(store.verify(OTHER_TOKEN)).resolves.toBeNull()
    expect(redis.has(indexKey('user', 'u-1'))).toBe(false)
    for (const entry of entries) {
      expect(redis.has(sidKeyOf('user', 'u-1', entry.sessionId))).toBe(false)
    }
  })
})
