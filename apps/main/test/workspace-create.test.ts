import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppLogger, Db } from '@repo/kits'
import { WorkspaceAdminService } from '../src/modules/ai-admin/workspace/workspace.service.js'

/**
 * 新建工作区必须 **`repo.create()` 之后 save**。
 *
 * 背景（2026-11-21 实测）：`BaseEntity.id` 由 `@BeforeInsert` 生成，TypeORM 对**普通对象** save
 * 不跑实体钩子 —— 直接 `save({...})` 时 id 走 `DEFAULT`（NULL），撞
 * `null value in column "id" of relation "ai_workspaces"`。接口层表现为 POST /ai-workspace/create 500。
 *
 * 这里用假仓储把契约钉住：save 收到的是**带 id 的实体**，且 create 被调用过。
 * 不连真库 / 真执行面（状态查询的 fetch 被 stub 掉）。
 */

const OWNER = { ownerType: 'admin' as const, ownerId: 'admin_1' }

const makeHarness = () => {
  const saved: Record<string, unknown>[] = []
  const repo = {
    // 模拟 TypeORM：create 产出的实例带 @BeforeInsert 生成的 id
    create: vi.fn((data: Record<string, unknown>) => ({ ...data, id: 'ws_created' })),
    save: vi.fn(async (entity: Record<string, unknown>) => {
      if (!entity.id) throw new Error('null value in column "id" of relation "ai_workspaces"')
      saved.push(entity)
      return { ...entity, createdAt: new Date(), updatedAt: new Date() }
    }),
    // ensureDefault 命中已有默认工作区 → 不再插第二条
    findOne: vi.fn(async () => ({ id: 'ws_default' })),
  }
  const db = { getRepository: vi.fn(() => repo) }
  const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const service = new WorkspaceAdminService(db as unknown as Db, logger as unknown as AppLogger)
  return { repo, saved, service }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('新建工作区：id 由实体钩子生成', () => {
  it('走 repo.create() 再 save，拿到的实体带 id', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline')
      }),
    )
    const { repo, saved, service } = makeHarness()

    const created = await service.create(OWNER, { name: '你好' })

    expect(repo.create).toHaveBeenCalledTimes(1)
    expect(saved).toHaveLength(1)
    expect(saved[0]?.id).toBe('ws_created')
    expect(saved[0]?.name).toBe('你好')
    expect(saved[0]?.isDefault).toBe(false)
    expect(created.id).toBe('ws_created')
    expect(created.name).toBe('你好')
  })

  it('已有默认工作区时 ensureDefault 不再插入（只建新的一条）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline')
      }),
    )
    const { repo, saved, service } = makeHarness()

    await service.create(OWNER, {})

    expect(repo.findOne).toHaveBeenCalled()
    expect(saved).toHaveLength(1)
    expect(saved[0]?.name).toBe('未命名工作区')
  })
})
