import { describe, expect, it, vi } from 'vitest'
import { AdminType } from '@repo/shared'
import type { AppLogger } from '@repo/kits'
import type { AdminEntity } from '@repo/db'
import { AdminService, ADMIN_TOKEN_TYPE } from '../src/modules/admin/admin.service.js'
import type { AdminRepository } from '../src/modules/admin/admin.repository.js'
import type { WorkspaceAdminService } from '../src/modules/ai-admin/workspace/workspace.service.js'

/**
 * 管理员类型随会话下发（`docs/design/workspace-cli-credentials.md` §6.10）。
 *
 * 只测**不碰库**的两段：登录写 claim + 会话、校验时只认会话里的类型。
 * 权限规则（谁能改类型、最后一个超管）是纯函数，另见 `admin-type-rules.test.ts`。
 */

const rowOf = (over: Partial<AdminEntity> = {}): AdminEntity =>
  ({
    id: 'adm_1',
    email: 'boss@billy.local',
    password: 'hashed',
    realName: null,
    avatar: null,
    status: 'enabled',
    type: AdminType.Normal,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    ...over,
  }) as unknown as AdminEntity

const makeService = (rows: AdminEntity[]) => {
  const repo = {
    findById: vi.fn(async (id: string) => rows.find((row) => row.id === id) ?? null),
    findByEmail: vi.fn(async (email: string) => rows.find((row) => row.email === email) ?? null),
    countByType: vi.fn(
      async (type: string) => rows.filter((row) => row.type === type && !row.deletedAt).length,
    ),
  }
  const sessions = {
    create: vi.fn(async () => undefined),
    verify: vi.fn(),
    revoke: vi.fn(),
    revokeAll: vi.fn(async () => undefined),
  }
  const signer = {
    sign: vi.fn(async (payload: object) => `token:${JSON.stringify(payload)}`),
    verify: vi.fn(),
  }
  const hasher = { hash: vi.fn(), verify: vi.fn(async () => true) }
  const logger = {
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as AppLogger
  const workspaces = { ensureDefault: vi.fn() } as unknown as WorkspaceAdminService

  const service = new AdminService(
    repo as unknown as AdminRepository,
    hasher as never,
    signer as never,
    sessions as never,
    logger,
    workspaces,
  )
  return { service, sessions, signer }
}

describe('登录：管理员类型同时进 claim 与服务端会话', () => {
  it('login 写入 adminType，并把类型回给前端', async () => {
    const { service, sessions, signer } = makeService([rowOf({ type: AdminType.God })])

    const result = await service.login({ email: 'boss@billy.local', password: 'secret' })

    expect(result.admin.type).toBe(AdminType.God)
    expect(signer.sign).toHaveBeenCalledWith({
      sub: 'adm_1',
      type: ADMIN_TOKEN_TYPE,
      adminType: AdminType.God,
    })
    expect(sessions.create).toHaveBeenCalledWith(
      expect.any(String),
      { sub: 'adm_1', type: 'admin', adminType: AdminType.God },
      expect.anything(),
    )
  })
})

describe('校验：管理员类型只认服务端会话', () => {
  it('库已是 god、会话仍是 normal 时以会话为准（旧 token 不能凭库里新身份越权）', async () => {
    const { service, sessions, signer } = makeService([rowOf({ type: AdminType.God })])
    signer.verify.mockResolvedValue({ sub: 'adm_1', type: ADMIN_TOKEN_TYPE })
    sessions.verify.mockResolvedValue({ sub: 'adm_1', type: 'admin', adminType: AdminType.Normal })

    await expect(service.verifyToken({ token: 't' })).resolves.toEqual({
      adminId: 'adm_1',
      adminType: AdminType.Normal,
    })
  })

  it('升级前登记的旧会话没有 adminType：按普通管理员处理', async () => {
    const { service, sessions, signer } = makeService([rowOf({ type: AdminType.God })])
    signer.verify.mockResolvedValue({ sub: 'adm_1', type: ADMIN_TOKEN_TYPE })
    sessions.verify.mockResolvedValue({ sub: 'adm_1', type: 'admin' })

    await expect(service.verifyToken({ token: 't' })).resolves.toEqual({
      adminId: 'adm_1',
      adminType: AdminType.Normal,
    })
  })

  it('会话已撤销（被踢下线 / 类型变更）时 token 失效', async () => {
    const { service, sessions, signer } = makeService([rowOf()])
    signer.verify.mockResolvedValue({ sub: 'adm_1', type: ADMIN_TOKEN_TYPE })
    sessions.verify.mockResolvedValue(null)

    await expect(service.verifyToken({ token: 't' })).rejects.toBeTruthy()
  })
})
