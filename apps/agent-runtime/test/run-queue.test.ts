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

const redis = {
  acquireLock: async () => 'lock-token',
  releaseLock: async () => true,
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
})
