import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppLogger, Db } from '@repo/kits'
import { AppErrorCodes } from '@repo/shared'
import { WorkspaceAdminService } from '../src/modules/ai-admin/workspace/workspace.service.js'

/**
 * 工作区的**执行驱动**（host / docker / kubernetes）控制面规则。
 *
 * 一套部署里默认走 `WORKSPACE_CONTAINER_RUNTIME`，但工作区可以单独指定 —— 这才是
 * 「按工作区解析环境」真正能落地的地方。钉三件事：
 * 1. 驱动必须与后端匹配：`host` 只能配 local，`docker` / `kubernetes` 只能配 container；
 * 2. 建工作区时写进 `container_runtime` 列；
 * 3. `null` = 回到部署默认。
 */

const OWNER = { ownerType: 'admin' as const, ownerId: 'admin_1' }

const ROW = {
  id: 'ws_1',
  ownerType: 'admin',
  ownerId: 'admin_1',
  name: '容器工作区',
  isDefault: false,
  backend: 'container',
  image: null,
  driver: 'container',
  location: null,
  fileAccess: 'write',
  desiredStatus: 'stopped',
  createdAt: new Date(),
  updatedAt: new Date(),
}

const makeHarness = (row: Record<string, unknown> | null = null) => {
  const saved: Record<string, unknown>[] = []
  const repo = {
    create: vi.fn((data: Record<string, unknown>) => ({ ...data, id: 'ws_new' })),
    save: vi.fn(async (entity: Record<string, unknown>) => {
      saved.push(entity)
      return { ...entity, createdAt: new Date(), updatedAt: new Date() }
    }),
    findOne: vi.fn(async () => row ?? { id: 'ws_default' }),
  }
  const db = { getRepository: vi.fn(() => repo) }
  const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const service = new WorkspaceAdminService(db as unknown as Db, logger as unknown as AppLogger)
  return { repo, saved, service }
}

const offline = (): void => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('offline')
    }),
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('创建：容器运行时', () => {
  it('container 后端 + pod → 写进 driver 列', async () => {
    offline()
    const { saved, service } = makeHarness()

    await service.create(OWNER, { backend: 'container', driver: 'pod' })

    expect(saved[0]?.backend).toBe('container')
    expect(saved[0]?.driver).toBe('pod')
  })

  it('不填后端 / 驱动 → 用部署默认（Docker 容器）', async () => {
    offline()
    const { saved, service } = makeHarness()

    await service.create(OWNER, {})

    expect(saved[0]?.backend).toBe('container')
    expect(saved[0]?.driver).toBe('container')
  })

  it('部署默认驱动是 host → 建出来的工作区是本机（backend 自动为 local）', async () => {
    offline()
    process.env.WORKSPACE_DEFAULT_DRIVER = 'host'
    try {
      const { saved, service } = makeHarness()
      await service.create(OWNER, {})
      expect(saved[0]?.backend).toBe('local')
      expect(saved[0]?.driver).toBe('host')
    } finally {
      delete process.env.WORKSPACE_DEFAULT_DRIVER
    }
  })

  it('local 后端配容器运行时 → 拒绝', async () => {
    offline()
    const { service } = makeHarness()

    await expect(
      service.create(OWNER, { backend: 'local', driver: 'docker' }),
    ).rejects.toMatchObject({ code: AppErrorCodes.WorkspaceHostRootInvalid })
  })
})

describe('更新：驱动创建后锁定', () => {
  it('改驱动 → 拒绝（换驱动请新建工作区）', async () => {
    offline()
    const { repo, service } = makeHarness({ ...ROW })

    await expect(service.update(OWNER, 'ws_1', { driver: 'pod' })).rejects.toThrow(/创建后不能更改/)

    expect(repo.save).not.toHaveBeenCalled()
  })

  it('传当前值 → 允许（幂等）', async () => {
    offline()
    const { saved, service } = makeHarness({ ...ROW })

    const updated = await service.update(OWNER, 'ws_1', { driver: 'container' })

    expect(updated.driver).toBe('container')
    expect(saved[0]?.driver).toBe('container')
  })

  it('local 工作区传 container / pod → 拒绝', async () => {
    offline()
    const { service } = makeHarness({ ...ROW, backend: 'local', driver: 'host' })

    await expect(service.update(OWNER, 'ws_1', { driver: 'container' })).rejects.toThrow(
      /创建后不能更改/,
    )
  })
})
