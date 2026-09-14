import { afterEach, describe, expect, it } from 'vitest'
import type { EntityManager } from 'typeorm'
import { DbService } from '../src/db/db.service.js'
import { Db } from '../src/db/db.js'
import { setAuditUserProvider } from '../src/db/audit-subscriber.js'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** 只用到 dataSource.manager 的 Db 替身 */
const fakeDb = (manager: EntityManager) =>
  ({ dataSource: { manager } }) as unknown as Db

/** 记录副作用、事务状态可控的 manager 替身 */
const recordingManager = (isTransactionActive = false) => {
  const inserts: unknown[][] = []
  const saves: unknown[][] = []
  const updates: { patch: unknown }[] = []
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
    update: async (_entity: unknown, _where: unknown, patch: unknown) => {
      updates.push({ patch })
      return {}
    },
    softDelete: async (_entity: unknown, where: unknown) => {
      softDeletes.push(where)
      return {}
    },
  } as unknown as EntityManager

  return { manager, inserts, saves, updates, softDeletes }
}

afterEach(() => {
  setAuditUserProvider(undefined)
})

describe('DbService', () => {
  it('manager 取 Db 的 DataSource 根 manager', () => {
    const { manager } = recordingManager()
    const service = new DbService(fakeDb(manager))
    expect(service.manager).toBe(manager)
  })

  it('operatorId 读审计钩子，未挂载时回落 system', () => {
    const { manager } = recordingManager()
    const service = new DbService(fakeDb(manager))

    expect(service.operatorId).toBe('system')
    setAuditUserProvider(() => 'user-1')
    expect(service.operatorId).toBe('user-1')
  })

  it('batchInsert 默认用根 manager', async () => {
    const { manager, inserts } = recordingManager()
    const service = new DbService(fakeDb(manager))

    await service.batchInsert(class Foo {} as never, [{ id: '1' }], {
      chunkSize: 10,
    })

    expect(inserts).toHaveLength(1)
  })

  it('显式传 manager 时优先使用传入的那个', async () => {
    const { manager: defaultManager, inserts: defaultInserts } = recordingManager()
    const { manager: txManager, inserts: txInserts } = recordingManager(true)
    const service = new DbService(fakeDb(defaultManager))

    await service.batchInsert(class Foo {} as never, [{ id: '1' }], {}, txManager)

    expect(txInserts).toHaveLength(1)
    expect(defaultInserts).toHaveLength(0)
  })

  it('batch 在根 manager 处于事务中时把并发降为 1', async () => {
    const { manager } = recordingManager(true)
    const service = new DbService(fakeDb(manager))

    let inFlight = 0
    let maxInFlight = 0
    await service.batch(
      [1, 2, 3, 4],
      async () => {
        inFlight += 1
        maxInFlight = Math.max(maxInFlight, inFlight)
        await sleep(5)
        inFlight -= 1
      },
      { chunkSize: 1, concurrency: 5 },
    )

    expect(maxInFlight).toBe(1)
  })

  it('batch 在非事务 manager 下使用传入并发度', async () => {
    const { manager } = recordingManager(false)
    const service = new DbService(fakeDb(manager))

    let inFlight = 0
    let maxInFlight = 0
    await service.batch(
      [1, 2, 3, 4],
      async () => {
        inFlight += 1
        maxInFlight = Math.max(maxInFlight, inFlight)
        await sleep(5)
        inFlight -= 1
      },
      { chunkSize: 1, concurrency: 2 },
    )

    expect(maxInFlight).toBe(2)
  })

  it('safeDelete 默认用当前操作人，可显式覆盖', async () => {
    const { manager, updates } = recordingManager()
    const service = new DbService(fakeDb(manager))
    setAuditUserProvider(() => 'user-9')

    await service.safeDelete(class Foo {} as never, { id: '1' })
    await service.safeDelete(class Foo {} as never, { id: '2' }, {
      operatorId: 'admin-1',
    })

    expect(updates[0].patch).toEqual({ deletedBy: 'user-9', updatedBy: 'user-9' })
    expect(updates[1].patch).toEqual({
      deletedBy: 'admin-1',
      updatedBy: 'admin-1',
    })
  })

  it('getFullSqlStatement 返回（不输出）还原后的 SQL', () => {
    const { manager } = recordingManager()
    const service = new DbService(fakeDb(manager))

    const sql = service.getFullSqlStatement({
      getQueryAndParameters: () => ['SELECT ?', [42]],
    } as never)

    expect(sql).toBe('SELECT 42')
  })

  it('pageWith 转发到分页内核，按 page/size 计算 skip/take', async () => {
    const { manager } = recordingManager()
    const service = new DbService(fakeDb(manager))

    const calls: { skip?: number; take?: number } = {}
    const builder = {
      clone: () => builder,
      skip: (n: number) => {
        calls.skip = n
        return builder
      },
      take: (n: number) => {
        calls.take = n
        return builder
      },
      getMany: async () => [{ id: '1' }],
      getCount: async () => 37,
    }

    const result = await service.pageWith(builder as never, 3, 10)

    expect(calls).toEqual({ skip: 20, take: 10 })
    expect(result).toEqual({ data: [{ id: '1' }], total: 37 })
  })

  it('batchDelete 转发到底层分片删除', async () => {
    const deletedChunks: unknown[][] = []
    const { manager } = recordingManager()
    const managerWithDelete = {
      ...manager,
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
    const service = new DbService(fakeDb(managerWithDelete))

    await service.batchDelete(class Foo {} as never, {
      selectIds: (() => ({ getRawMany: async () => [{ id: 'a' }, { id: 'b' }] })) as never,
    })

    expect(deletedChunks).toEqual([['a', 'b']])
  })
})
