import { describe, expect, it, vi } from 'vitest'
import type { EntityManager } from 'typeorm'
import {
  batch,
  batchDelete,
  batchInsert,
  batchSave,
  batchUpsert,
  resolveBatchConcurrency,
} from '../src/db/batch.js'
import { safeDelete } from '../src/db/safe-delete.js'
import { getFullSqlStatement } from '../src/db/sql.js'
import { BatchOperationError } from '../src/foundation/errors/infrastructure-errors.js'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** 事务状态可控的 EntityManager 替身（只用到 queryRunner.isTransactionActive） */
const fakeManager = (isTransactionActive: boolean) =>
  ({ queryRunner: { isTransactionActive } }) as unknown as EntityManager

/** 记录副作用调用的 EntityManager 替身，覆盖批量方法用到的全部 API */
const recordingManager = (isTransactionActive = false) => {
  const inserts: unknown[][] = []
  const saves: unknown[][] = []
  const upserts: unknown[][] = []
  const updates: { where: unknown; patch: unknown }[] = []
  const softDeletes: unknown[] = []

  const manager = {
    queryRunner: { isTransactionActive },
    createQueryBuilder: () => ({
      insert: () => ({
        into: () => ({
          values: (values: unknown[]) => ({
            execute: async () => {
              inserts.push(values)
            },
          }),
        }),
      }),
    }),
    save: async (chunk: unknown[]) => {
      saves.push(chunk)
      return chunk
    },
    upsert: async (_entity: unknown, chunk: unknown[]) => {
      upserts.push(chunk)
      return {}
    },
    update: async (_entity: unknown, where: unknown, patch: unknown) => {
      updates.push({ where, patch })
      return {}
    },
    softDelete: async (_entity: unknown, where: unknown) => {
      softDeletes.push(where)
      return {}
    },
  } as unknown as EntityManager

  return { manager, inserts, saves, upserts, updates, softDeletes }
}

describe('resolveBatchConcurrency', () => {
  it('事务内强制串行，事务外使用传入并发度', () => {
    expect(resolveBatchConcurrency(fakeManager(true), 5)).toBe(1)
    expect(resolveBatchConcurrency(fakeManager(false), 5)).toBe(5)
  })

  it('未传并发度时默认 5', () => {
    expect(resolveBatchConcurrency(fakeManager(false))).toBe(5)
  })
})

describe('batch', () => {
  it('按 chunkSize 切片，末片保留余数', async () => {
    const chunks: number[][] = []
    await batch(
      Array.from({ length: 25 }, (_, index) => index),
      async (chunk) => {
        chunks.push(chunk)
      },
      { chunkSize: 10, concurrency: 1 },
    )

    expect(chunks.map((chunk) => chunk.length).sort((a, b) => a - b)).toEqual([5, 10, 10])
  })

  it('并发度受 concurrency 限制', async () => {
    let inFlight = 0
    let maxInFlight = 0

    await batch(
      Array.from({ length: 10 }, (_, index) => index),
      async () => {
        inFlight += 1
        maxInFlight = Math.max(maxInFlight, inFlight)
        await sleep(5)
        inFlight -= 1
      },
      { chunkSize: 1, concurrency: 2 },
    )

    expect(maxInFlight).toBeLessThanOrEqual(2)
  })

  it('空数组不调用 handler', async () => {
    const handler = vi.fn()
    await batch([], handler)
    expect(handler).not.toHaveBeenCalled()
  })

  it('部分分片失败时聚合抛 BatchOperationError，且其余分片照常执行', async () => {
    const handled: number[][] = []

    const error = await batch(
      [1, 2, 3, 4],
      async (chunk) => {
        handled.push(chunk)
        if (chunk[0] === 3) throw new Error('boom')
      },
      { chunkSize: 2, concurrency: 1 },
    ).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(BatchOperationError)
    expect((error as BatchOperationError).failedChunks).toBe(1)
    expect((error as BatchOperationError).failures[0]).toBeInstanceOf(Error)
    // 失败的分片不阻断后续分片
    expect(handled).toHaveLength(2)
  })
})

describe('批量写入方法', () => {
  const rows = Array.from({ length: 5 }, (_, index) => ({ id: `${index}` }))

  it('batchInsert 每片一条 insert，事务内并发降为 1 且分片完整', async () => {
    const { manager, inserts } = recordingManager(true)
    await batchInsert(manager, class Foo {}, rows, { chunkSize: 2 })

    expect(inserts.map((chunk) => chunk.length).sort((a, b) => a - b)).toEqual([1, 2, 2])
  })

  it('batchSave 走 manager.save', async () => {
    const { manager, saves } = recordingManager()
    await batchSave(manager, rows, { chunkSize: 2 })

    expect(saves.map((chunk) => chunk.length).sort((a, b) => a - b)).toEqual([1, 2, 2])
  })

  it('batchUpsert 走 manager.upsert', async () => {
    const { manager, upserts } = recordingManager()
    await batchUpsert(manager, class Foo {}, rows, ['id'], { chunkSize: 2 })

    expect(upserts.map((chunk) => chunk.length).sort((a, b) => a - b)).toEqual([1, 2, 2])
  })
})

describe('safeDelete', () => {
  it('先写操作人再软删，顺序不可颠倒', async () => {
    const calls: string[] = []
    const manager = {
      update: async () => {
        calls.push('update')
        return {}
      },
      softDelete: async () => {
        calls.push('softDelete')
        return {}
      },
    } as unknown as EntityManager

    // 实体类型收窄为 AuditEntity，测试里用替身断言调用顺序即可
    await safeDelete(manager, class Foo {} as never, { id: '1' }, 'admin-1')

    expect(calls).toEqual(['update', 'softDelete'])
  })
})

describe('getFullSqlStatement', () => {
  const buildStatement = (sql: string, params: unknown[]) =>
    getFullSqlStatement({
      getQueryAndParameters: () => [sql, params],
    } as unknown as Parameters<typeof getFullSqlStatement>[0])

  it('按占位符顺序还原数字 / 字符串 / null / 布尔', () => {
    const sql = buildStatement('SELECT * FROM t WHERE a = ? AND b = ? AND c = ? AND d = ?', [
      1,
      'x',
      null,
      true,
    ])

    expect(sql).toBe("SELECT * FROM t WHERE a = 1 AND b = 'x' AND c = NULL AND d = true")
  })

  it('转义字符串中的单引号', () => {
    expect(buildStatement('SELECT ?', ["o'brien"])).toBe("SELECT 'o''brien'")
  })

  it('Date 走 formatTime，还原为可读时间字符串', () => {
    const sql = buildStatement('SELECT ?', [new Date('2026-09-13T10:20:30')])
    expect(sql).toMatch(/^SELECT '\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}'$/)
  })

  it('参数不足时保留占位符，不抛错', () => {
    expect(buildStatement('SELECT ? AND ?', [1])).toBe('SELECT 1 AND ?')
  })
})

describe('batchDelete', () => {
  /** 记录每片被删主键的 manager 替身 */
  const deleteManager = (ids: string[], isTransactionActive = false) => {
    const deletedChunks: unknown[][] = []
    const manager = {
      queryRunner: { isTransactionActive },
      createQueryBuilder: () => ({
        delete: () => ({
          from: () => ({
            whereInIds: (chunk: unknown[]) => ({
              execute: async () => {
                deletedChunks.push(chunk)
              },
            }),
          }),
        }),
      }),
    } as unknown as EntityManager
    const buildIds = () =>
      ({
        getRawMany: async () => ids.map((id) => ({ id })),
      }) as never
    return { manager, deletedChunks, buildIds }
  }

  it('先取主键再分片删除', async () => {
    const { manager, deletedChunks, buildIds } = deleteManager(['1', '2', '3', '4', '5'])

    await batchDelete(manager, class Foo {}, {
      selectIds: buildIds,
      chunkSize: 2,
    })

    expect(deletedChunks.map((c) => c.length).sort((a, b) => a - b)).toEqual([1, 2, 2])
  })

  it('无目标主键时不发删除语句', async () => {
    const { manager, deletedChunks, buildIds } = deleteManager([])

    await batchDelete(manager, class Foo {}, { selectIds: buildIds })

    expect(deletedChunks).toHaveLength(0)
  })

  it('支持自定义主键列名', async () => {
    const deletedChunks: unknown[][] = []
    const manager = {
      queryRunner: { isTransactionActive: false },
      createQueryBuilder: () => ({
        delete: () => ({
          from: () => ({
            whereInIds: (chunk: unknown[]) => ({
              execute: async () => {
                deletedChunks.push(chunk)
              },
            }),
          }),
        }),
      }),
    } as unknown as EntityManager
    const selectIds = (() =>
      ({
        getRawMany: async () => [{ todoId: 'a' }, { todoId: 'b' }],
      }) as never) as never

    await batchDelete(manager, class Foo {}, { selectIds, idCol: 'todoId' })

    expect(deletedChunks).toEqual([['a', 'b']])
  })
})
