import 'dotenv/config'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Db, type AppLogger, type RedisStore } from '@repo/kits'
import { ConversationRunQueueEntity } from '@repo/db'
import { ConversationRunQueue } from '../src/modules/ai/runtime/run-queue.service.js'

const logger = {
  setContext: () => undefined,
  info: () => undefined,
  log: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
} as unknown as AppLogger

/** 测试用的内存版 Redis：只实现队列服务用到的那几个命令（锁 + 交付标记） */
const redisValues = new Map<string, string>()
const redis = {
  acquireLock: async () => 'lock-token',
  releaseLock: async () => true,
  set: async (key: string, value: string) => {
    redisValues.set(key, value)
    return 'OK'
  },
  exists: async (key: string) => (redisValues.has(key) ? 1 : 0),
} as unknown as RedisStore

const CONV = 'test-run-queue-conv'

let db: Db
let queue: ConversationRunQueue

beforeAll(async () => {
  db = new Db(
    { url: process.env.DB_URL!, sync: false, entities: [ConversationRunQueueEntity] } as never,
    logger,
  )
  await db.onApplicationBootstrap()
  if (!db.dataSource.isInitialized) throw new Error('数据库初始化失败')
  await db.dataSource.query('DELETE FROM conversation_run_queue WHERE conversation_id = $1', [CONV])
  queue = new ConversationRunQueue(db, redis, logger)
})

afterAll(async () => {
  await db.dataSource.query('DELETE FROM conversation_run_queue WHERE conversation_id = $1', [CONV])
  await db.close()
})

describe('ConversationRunQueue', () => {
  it('用户 queue 优先于子 agent 完成；同优先级 FIFO', async () => {
    await queue.enqueue({
      conversationId: CONV,
      source: 'subagent',
      payload: { child: 1 },
      dedupeKey: `${CONV}-sub-1`,
    })
    await queue.enqueue({ conversationId: CONV, source: 'user', payload: { text: 'hi' } })

    const first = await queue.claimNext(CONV)
    expect(first?.source).toBe('user')
    await queue.markStarted(first!.id, 'run-user-1')
    await queue.markDone(first!.id)

    const second = await queue.claimNext(CONV)
    expect(second?.source).toBe('subagent')
    expect(second?.dedupeKey).toBe(`${CONV}-sub-1`)
  })

  it('取消后条件转移全部失败，终态不会被复活', async () => {
    const row = await queue.enqueue({
      conversationId: CONV,
      source: 'user',
      payload: { text: 'cancel-race' },
    })
    expect(await queue.cancel(row.id)).toBe(true)

    expect(await queue.markStarted(row.id, 'run-late')).toBe(false)
    expect(await queue.markDone(row.id)).toBe(false)
    expect(await queue.markFailed(row.id, 'late-failure')).toBe(false)
    expect(await queue.requeue(row.id)).toBe(false)

    const rows = await queue.listUnfinished()
    expect(rows.some((item) => item.id === row.id)).toBe(false)
  })

  it('updateUserItem / cancelUserItem 只改用户自己排队的项', async () => {
    const row = await queue.enqueue({
      conversationId: CONV,
      source: 'user',
      payload: { message: 'old' },
    })

    const updated = await queue.updateUserItem(CONV, row.id, 'new')
    expect(updated?.payload.message).toBe('new')

    expect(await queue.cancelUserItem(CONV, row.id)).toBe(true)
    expect(await queue.updateUserItem(CONV, row.id, 'again')).toBeNull()
    expect(await queue.cancelUserItem(CONV, row.id)).toBe(false)
  })

  it('dedupeKey 重复入队返回同一行', async () => {
    const a = await queue.enqueue({
      conversationId: CONV,
      source: 'subagent',
      payload: { x: 1 },
      dedupeKey: `${CONV}-dup`,
    })
    const b = await queue.enqueue({
      conversationId: CONV,
      source: 'subagent',
      payload: { x: 2 },
      dedupeKey: `${CONV}-dup`,
    })
    expect(b.id).toBe(a.id)
    expect(b.payload).toEqual({ x: 1 })
  })

  it('取消会话队列 / 按 dedupe 取消', async () => {
    await queue.enqueue({
      conversationId: CONV,
      source: 'subagent',
      payload: {},
      dedupeKey: `${CONV}-cancel-1`,
    })
    expect(await queue.cancelByDedupe(`${CONV}-cancel-1`)).toBe(true)
    const row = await queue.findByDedupe(`${CONV}-cancel-1`)
    expect(row?.status).toBe('canceled')

    await queue.enqueue({ conversationId: CONV, source: 'user', payload: {} })
    await queue.enqueue({
      conversationId: CONV,
      source: 'subagent',
      payload: {},
      dedupeKey: `${CONV}-cancel-2`,
    })
    expect(await queue.cancelConversation(CONV, 'subagent')).toBeGreaterThan(0)
    const pending = await queue.pendingCount(CONV)
    expect(pending).toBeGreaterThanOrEqual(1) // 用户项不被 source=subagent 取消
  })

  it('「已交付」标记：先标记、后入队也能挡住（子 run 翻终态早于入队的那个窗口）', async () => {
    const subRunId = `${CONV}-late-wake`
    // 父的 wait 先拿到结果：此时队列行还不存在，只能打事实标记
    expect(await queue.isConsumed(subRunId)).toBe(false)
    await queue.markConsumed(subRunId)
    expect(await queue.isConsumed(subRunId)).toBe(true)
    expect(await queue.listQueuedSubAgentKeys(CONV)).not.toContain(subRunId)
  })

  it('listQueuedSubAgentKeys 只回本会话排着队的子 agent 完成项', async () => {
    // 清掉前面用例留下的 queued 行，本用例只看自己这两条
    await queue.cancelConversation(CONV)
    await queue.enqueue({
      conversationId: CONV,
      source: 'subagent',
      payload: {},
      dedupeKey: `${CONV}-pending-sub`,
    })
    await queue.enqueue({ conversationId: CONV, source: 'user', payload: {} })
    const keys = await queue.listQueuedSubAgentKeys(CONV)
    // 用户项不是子 agent 完成，不该出现在这个集合里
    expect(keys).toEqual([`${CONV}-pending-sub`])
  })
})
