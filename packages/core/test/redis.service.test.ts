import { Deferred, Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import { RedisService } from '../src/infra/redis.service.js'
import { runEffect } from './helpers/integration.js'

describe('RedisService with real Redis', () => {
  it('persists strings, collections, hashes, and JSON', async () => {
    const result = await runEffect(
      Effect.gen(function* () {
        const redis = yield* RedisService
        yield* redis.set('string', 'value')
        yield* redis.sadd('set', 'a', 'b')
        yield* redis.rpush('list', 'first', 'second')
        yield* redis.hset('hash', 'field', 'value')
        yield* redis.setJson('json', { active: true })
        return {
          string: yield* redis.get('string'),
          set: yield* redis.smembers('set'),
          list: yield* redis.lrange('list', 0, -1),
          hash: yield* redis.hget('hash', 'field'),
          json: yield* redis.getJson<{ active: boolean }>('json'),
        }
      }),
    )

    expect(result).toEqual({
      string: 'value',
      set: expect.arrayContaining(['a', 'b']),
      list: ['first', 'second'],
      hash: 'value',
      json: { active: true },
    })
  })

  it('acquires and safely releases a real distributed lock', async () => {
    const result = await runEffect(
      Effect.gen(function* () {
        const redis = yield* RedisService
        const token = yield* redis.acquireLock('lock', 10)
        const second = yield* redis.acquireLock('lock', 10)
        const wrongRelease = yield* redis.releaseLock('lock', 'wrong-token')
        const released = yield* redis.releaseLock('lock', token!)
        return { token, second, wrongRelease, released }
      }),
    )
    expect(result.token).toBeTruthy()
    expect(result.second).toBeNull()
    expect(result.wrongRelease).toBe(false)
    expect(result.released).toBe(true)
  })

  it('publishes through a real subscriber connection', async () => {
    const message = await runEffect(
      Effect.gen(function* () {
        const redis = yield* RedisService
        const deferred = yield* Deferred.make<string>()
        yield* redis.subscribe('events', (value) => {
          Effect.runSync(Deferred.succeed(deferred, value))
        })
        yield* redis.publish('events', 'received')
        const value = yield* Deferred.await(deferred)
        yield* redis.unsubscribe('events')
        return value
      }),
    )
    expect(message).toBe('received')
  })
})
