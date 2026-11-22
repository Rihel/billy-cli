import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppLogger, Db } from '@repo/kits'
import { AppErrorCodes } from '@repo/shared'
import { WorkspaceAdminService } from '../src/modules/ai-admin/workspace/workspace.service.js'

/**
 * 工作区的**文件夹**（`local` 后端）控制面契约。
 *
 * 钉四件事：
 * 1. `root` 只能是 `local` 后端：容器工作区配文件夹直接拒绝（配置会静默失效，属于配置错误）；
 * 2. 语法校验在 main 做（绝对路径 / 不是 `/` / 不含 `..`）——**存在性与允许根由执行面校验**，
 *    因为 main 与 workspace-service 可能不在同一台机器 / 同一个容器里；
 * 3. 合法值落到 `location.root`（jsonb，不新增列、不需要迁移）；
 * 4. `update` 传 `null` 能清空，回到平台托管目录。
 */

const OWNER = { ownerType: 'admin' as const, ownerId: 'admin_1' }

const ROW = {
  id: 'ws_1',
  ownerType: 'admin',
  ownerId: 'admin_1',
  name: '本地项目',
  isDefault: false,
  backend: 'local',
  image: null,
  location: { root: '/Users/me/code/project' },
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
    // ensureDefault 命中已有默认工作区；update 走 save(row)
    findOne: vi.fn(async () => row ?? { id: 'ws_default' }),
  }
  const db = { getRepository: vi.fn(() => repo) }
  const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const service = new WorkspaceAdminService(db as unknown as Db, logger as unknown as AppLogger)
  return { repo, saved, service }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

const offline = (): void => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('offline')
    }),
  )
}

describe('创建：文件夹', () => {
  it('local 后端 + 绝对路径 → 落到 location.root', async () => {
    offline()
    const { saved, service } = makeHarness()

    await service.create(OWNER, { backend: 'local', root: '/Users/me/code/todo-app/' })

    expect(saved[0]?.backend).toBe('local')
    // 末尾斜杠归一掉
    expect(saved[0]?.location).toEqual({ root: '/Users/me/code/todo-app' })
  })

  it('container 后端配文件夹 → 拒绝', async () => {
    offline()
    const { service } = makeHarness()

    await expect(
      service.create(OWNER, { backend: 'container', root: '/Users/me/code/todo-app' }),
    ).rejects.toMatchObject({ code: AppErrorCodes.WorkspaceHostRootInvalid })
  })

  it.each([
    ['相对路径', 'code/todo-app', /绝对路径/],
    ['根目录', '/', /不能是整个根目录/],
    ['含 .. 段', '/Users/me/../etc', /不能含 \.\./],
  ])('%s → 拒绝', async (_name, root, message) => {
    offline()
    const { service } = makeHarness()

    await expect(service.create(OWNER, { backend: 'local', root })).rejects.toMatchObject({
      code: AppErrorCodes.WorkspaceHostRootInvalid,
    })
    await expect(service.create(OWNER, { backend: 'local', root })).rejects.toThrow(message)
  })

  it('不填文件夹 → location 为 null（平台托管目录）', async () => {
    offline()
    const { saved, service } = makeHarness()

    await service.create(OWNER, { backend: 'local' })

    expect(saved[0]?.location).toBeNull()
  })
})

describe('更新：文件夹', () => {
  it('local 工作区改路径 → 更新 location', async () => {
    offline()
    const { saved, service } = makeHarness({ ...ROW })

    const updated = await service.update(OWNER, 'ws_1', { root: '/Users/me/code/another' })

    expect(saved[0]?.location).toEqual({ root: '/Users/me/code/another' })
    expect(updated.root).toBe('/Users/me/code/another')
  })

  it('传 null → 清空回平台托管目录', async () => {
    offline()
    const { saved, service } = makeHarness({ ...ROW })

    const updated = await service.update(OWNER, 'ws_1', { root: null })

    expect(saved[0]?.location).toBeNull()
    expect(updated.root).toBeNull()
  })

  it('container 工作区配文件夹 → 拒绝', async () => {
    offline()
    const { service } = makeHarness({ ...ROW, backend: 'container', location: null })

    await expect(service.update(OWNER, 'ws_1', { root: '/Users/me/code/x' })).rejects.toMatchObject(
      { code: AppErrorCodes.WorkspaceHostRootInvalid },
    )
  })
})
