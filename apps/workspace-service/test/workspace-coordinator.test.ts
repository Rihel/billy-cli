import 'dotenv/config'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { IdGeneration, RedisLockService, RedisStore } from '@repo/kits'
import { WorkspaceCoordinator } from '../src/workspace/workspace-coordinator.js'

const silentLogger = {
  info: () => undefined,
  log: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
} as never

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379/15'

let store: RedisStore
let lock: RedisLockService
let coordinatorA: WorkspaceCoordinator
let coordinatorB: WorkspaceCoordinator

beforeAll(async () => {
  store = new RedisStore(
    { url: REDIS_URL, keyPrefix: `wstest:${randomUUID()}:` } as never,
    new IdGeneration(),
    silentLogger,
  )
  await store.onApplicationBootstrap()
  lock = new RedisLockService(store, new IdGeneration(), silentLogger)
  coordinatorA = new WorkspaceCoordinator(lock, store)
  coordinatorB = new WorkspaceCoordinator(lock, store)
})

afterAll(async () => {
  await store.close()
})

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

describe('WorkspaceCoordinator（Redis 跨副本锁）', () => {
  it('同一 workspace 的 exec 锁跨两个 coordinator 串行', async () => {
    const workspaceId = `ws-${randomUUID()}`
    let active = 0
    let max = 0
    const task = async (): Promise<void> => {
      active += 1
      max = Math.max(max, active)
      await sleep(40)
      active -= 1
    }

    await Promise.all([
      coordinatorA.withLock('exec', workspaceId, task),
      coordinatorB.withLock('exec', workspaceId, task),
    ])

    expect(max).toBe(1)
  })

  it('tryWithLock 在另一个副本持锁时返回 acquired=false', async () => {
    const workspaceId = `ws-${randomUUID()}`
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })

    const held = coordinatorA.withLock('exec', workspaceId, () => gate)
    await sleep(20)

    const attempt = await coordinatorB.tryWithLock('exec', workspaceId, async () => 'nope')
    expect(attempt.acquired).toBe(false)

    release()
    await held
  })

  it('lastUsed 在副本间共享，clear 后消失', async () => {
    const workspaceId = `ws-${randomUUID()}`

    await coordinatorA.touch(workspaceId)
    const seenByB = await coordinatorB.lastUsed(workspaceId)
    expect(seenByB).toBeTypeOf('number')

    await coordinatorB.clear(workspaceId)
    expect(await coordinatorA.lastUsed(workspaceId)).toBeNull()
  })
})
