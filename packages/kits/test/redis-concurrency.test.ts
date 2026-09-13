import { describe, expect, it } from 'vitest'
import type { RedisStore } from '../src/redis/redis-store.js'
import { RedisListCache } from '../src/redis/redis-list-cache.js'
import { RedisLockService } from '../src/redis/redis-lock.service.js'
import { RedisLockError } from '../src/foundation/errors/infrastructure-errors.js'
import { testLogger } from './helpers/logger.js'

interface Row {
  id: string
  name: string
}

/** 最小 Hash 语义的假 Redis（覆盖 RedisListCache 用到的命令） */
const createFakeRedisStore = () => {
  const hashes = new Map<string, Map<string, string>>()
  const hashOf = (key: string) => {
    let hash = hashes.get(key)
    if (!hash) hashes.set(key, (hash = new Map()))
    return hash
  }

  const raw = {
    hgetall: async (key: string) =>
      Object.fromEntries(hashOf(key).entries()) as Record<string, string>,
    hset: async (key: string, field: string, value: string) => {
      hashOf(key).set(field, value)
      return 1
    },
    hdel: async (key: string, ...fields: string[]) => {
      const hash = hashOf(key)
      let removed = 0
      for (const field of fields) if (hash.delete(field)) removed++
      return removed
    },
    del: async (key: string) => (hashes.delete(key) ? 1 : 0),
    pipeline: () => {
      const ops: Array<() => Promise<unknown>> = []
      const pipeline = {
        hset: (key: string, field: string, value: string) => {
          ops.push(() => raw.hset(key, field, value))
          return pipeline
        },
        exec: async () => {
          for (const op of ops) await op()
          return []
        },
      }
      return pipeline
    },
  }

  return { store: { raw } as unknown as RedisStore, hashes }
}

describe('RedisListCache（Hash 列表缓存）', () => {
  it('set / get 往返，空缓存返回空数组', async () => {
    const { store } = createFakeRedisStore()
    const cache = new RedisListCache<Row, 'id'>('row:all', store, 'id')

    expect(await cache.get()).toEqual([])

    await cache.set([
      { id: '1', name: 'a' },
      { id: '2', name: 'b' },
    ])
    expect((await cache.get()).sort((x, y) => x.id.localeCompare(y.id))).toEqual([
      { id: '1', name: 'a' },
      { id: '2', name: 'b' },
    ])
  })

  it('set 为全量覆盖（旧数据被清空）', async () => {
    const { store } = createFakeRedisStore()
    const cache = new RedisListCache<Row, 'id'>('row:all', store, 'id')

    await cache.set([{ id: '1', name: 'a' }])
    await cache.set([{ id: '2', name: 'b' }])

    expect(await cache.get()).toEqual([{ id: '2', name: 'b' }])
  })

  it('add / updateByPrimary / removeByPrimary / removeByPrimaries', async () => {
    const { store } = createFakeRedisStore()
    const cache = new RedisListCache<Row, 'id'>('row:all', store, 'id')

    await cache.add({ id: '1', name: 'a' })
    await cache.add({ id: '2', name: 'b' })
    await cache.updateByPrimary('1', { id: '1', name: 'a2' })
    expect((await cache.get()).find((item) => item.id === '1')?.name).toBe('a2')

    await cache.removeByPrimary('1')
    expect((await cache.get()).map((item) => item.id)).toEqual(['2'])

    await cache.removeByPrimaries(['2'])
    expect(await cache.get()).toEqual([])
  })

  it('empty 清空整个 Hash', async () => {
    const { store, hashes } = createFakeRedisStore()
    const cache = new RedisListCache<Row, 'id'>('row:all', store, 'id')

    await cache.set([{ id: '1', name: 'a' }])
    await cache.empty()

    expect(hashes.has('row:all')).toBe(false)
  })
})

/** 最小 SET NX / Lua 语义的假 Redis（覆盖 RedisLockService 用到的命令） */
const createFakeLockStore = () => {
  const locks = new Map<string, string>()
  const scriptShas = new Map<string, string>()
  let seq = 0

  const raw = {
    set: async (
      key: string,
      value: string,
      _ex?: string,
      _ttl?: number,
      nx?: string,
    ) => {
      if (nx && locks.has(key)) return null
      locks.set(key, value)
      return 'OK'
    },
    script: async (_cmd: string, source: string) => {
      let sha = scriptShas.get(source)
      if (!sha) scriptShas.set(source, (sha = `sha-${++seq}`))
      return sha
    },
    /** unlock 脚本删 key 返回 1；renew 脚本仅当持有者匹配返回 1 */
    evalsha: async (sha: string, _numKeys: number, key: string, value: string) => {
      const isUnlock = [...scriptShas.entries()].find(([, s]) => s === sha)?.[0]
        ?.includes('del')
      if (locks.get(key) !== value) return 0
      if (isUnlock) {
        locks.delete(key)
      }
      return 1
    },
  }

  return { store: { raw } as unknown as RedisStore, locks }
}

const fakeIdGeneration = { next: () => 'lock-token' } as never

describe('RedisLockService（分布式锁）', () => {
  it('withLock：成功执行后自动释放锁', async () => {
    const { store, locks } = createFakeLockStore()
    const service = new RedisLockService(store, fakeIdGeneration, testLogger())

    const result = await service.withLock('order:1', 30, 1, async () => 'done')

    expect(result).toBe('done')
    expect(locks.size).toBe(0)
    expect(service.heldCount).toBe(0)
  })

  it('withLock：业务抛错也会释放锁', async () => {
    const { store, locks } = createFakeLockStore()
    const service = new RedisLockService(store, fakeIdGeneration, testLogger())

    await expect(
      service.withLock('order:1', 30, 1, () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')

    expect(locks.size).toBe(0)
  })

  it('unlock：非持有者无法释放（返回 false）', async () => {
    const { store, locks } = createFakeLockStore()
    const service = new RedisLockService(store, fakeIdGeneration, testLogger())
    locks.set('order:1', 'other-token')

    expect(await service.unlock('order:1', 'lock-token')).toBe(false)
    expect(locks.get('order:1')).toBe('other-token')
  })

  it('lock：等待超时抛 RedisLockError（映射 4002）', async () => {
    const { store, locks } = createFakeLockStore()
    const service = new RedisLockService(store, fakeIdGeneration, testLogger())
    locks.set('order:1', 'other-token')

    const error = await service.lock('order:1', 30, 0.2).catch((err: unknown) => err)

    expect(error).toBeInstanceOf(RedisLockError)
    expect((error as RedisLockError).code).toBe(4002)
  })
})
