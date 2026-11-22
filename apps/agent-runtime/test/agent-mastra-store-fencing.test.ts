import 'dotenv/config'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { RunFenceConflictError } from '@mastra/core/storage'
import { Db } from '@repo/kits'
import { DB_ENTITIES } from '@repo/db'
import { AgentWorkflowsStorage } from '../src/modules/ai/runtime/storage/agent-mastra-store.js'

const silentLogger = {
  info: () => undefined,
  log: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
} as never

let db: Db
let storage: AgentWorkflowsStorage
const createdRunIds: string[] = []

beforeAll(async () => {
  db = new Db(
    { url: process.env.DB_URL!, sync: false, entities: [...DB_ENTITIES] } as never,
    silentLogger,
  )
  await db.onApplicationBootstrap()
  if (!db.dataSource.isInitialized) throw new Error('数据库初始化失败')
  storage = new AgentWorkflowsStorage(db, silentLogger)
})

afterAll(async () => {
  if (createdRunIds.length > 0) {
    await db.dataSource.query('DELETE FROM run_ownership WHERE run_id = ANY($1)', [createdRunIds])
  }
  await db.close()
})

const newRunId = (): string => {
  const runId = `test-own-${randomUUID()}`
  createdRunIds.push(runId)
  return runId
}

describe('AgentWorkflowsStorage run fencing', () => {
  it('同一 run 只允许一个持有者；generation 随重新 claim 递增', async () => {
    const runId = newRunId()

    const first = await storage.claimRunOwnership({ runId, ownerId: 'pod-a', leaseMs: 60_000 })
    expect(first.acquired).toBe(true)
    expect(first.record?.ownerId).toBe('pod-a')
    expect(first.record?.live).toBe(true)

    const second = await storage.claimRunOwnership({ runId, ownerId: 'pod-b', leaseMs: 60_000 })
    expect(second.acquired).toBe(false)
    expect(second.record?.ownerId).toBe('pod-a')

    await storage.releaseRunOwnership({
      runId,
      ownerId: 'pod-a',
      generation: first.record!.generation,
    })

    const third = await storage.claimRunOwnership({ runId, ownerId: 'pod-b', leaseMs: 60_000 })
    expect(third.acquired).toBe(true)
    expect(third.record!.generation).toBeGreaterThan(first.record!.generation)
  })

  it('旧 generation 的写入被 RunFenceConflictError 拒绝', async () => {
    const runId = newRunId()
    const first = await storage.claimRunOwnership({ runId, ownerId: 'pod-a', leaseMs: 60_000 })
    const oldFence = {
      runId,
      ownerId: 'pod-a',
      generation: first.record!.generation,
    }

    await expect(
      storage.updateWorkflowState({
        workflowName: 'durable-agentic-loop',
        runId,
        opts: {},
        fence: oldFence,
      }),
    ).resolves.toBeTruthy()

    const second = await storage.claimRunOwnership({
      runId,
      ownerId: 'pod-b',
      leaseMs: 60_000,
      force: true,
    })
    expect(second.acquired).toBe(true)
    expect(second.record!.generation).toBeGreaterThan(oldFence.generation)

    await expect(
      storage.updateWorkflowState({
        workflowName: 'durable-agentic-loop',
        runId,
        opts: {},
        fence: oldFence,
      }),
    ).rejects.toBeInstanceOf(RunFenceConflictError)
  })
})
