import { describe, expect, it, vi } from 'vitest'
import { requestContext } from '@repo/kits'
import { AppErrorCodes } from '@repo/shared'
import { SkillAdminService } from '../src/modules/ai-admin/skill/skill.service.js'
import type { SkillRepository } from '../src/modules/ai-admin/skill/skill.repository.js'

/** 个人技能配额（§6.7.5）：50 个上限，超了直接拒绝（不静默丢弃） */
const make = (owned: number) => {
  const repo = {
    countPersonal: vi.fn(async () => owned),
    existsInScope: vi.fn(async () => false),
    create: vi.fn(async () => {
      throw new Error('后续步骤失败（这里只验证配额没拦）')
    }),
  }
  const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() } as never
  const service = new SkillAdminService(
    repo as unknown as SkillRepository,
    { notify: vi.fn() } as never,
    logger,
  )
  return { service, repo }
}

const input = { skillKey: 'my-skill', description: '什么时候用', body: '正文' }

const runAsUser = <T>(fn: () => Promise<T>): Promise<T> =>
  requestContext.run({ requestId: 't', userId: 'u_1', adminId: null }, fn)

describe('个人技能配额', () => {
  it('已达 50 个 → 拒绝创建（3601），不写库', async () => {
    const { service, repo } = make(50)

    await expect(runAsUser(() => service.create(input))).rejects.toMatchObject({
      code: AppErrorCodes.SkillQuotaExceeded,
    })
    expect(repo.create).not.toHaveBeenCalled()
  })

  it('未达上限 → 配额不拦，按 personal + 自身 owner 落库', async () => {
    const { service, repo } = make(49)

    const error = await runAsUser(() => service.create(input)).catch((cause: unknown) => cause)

    expect(repo.countPersonal).toHaveBeenCalledWith({ ownerType: 'user', ownerId: 'u_1' })
    expect((error as Error).message).toBe('后续步骤失败（这里只验证配额没拦）')
    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'personal', ownerType: 'user', ownerId: 'u_1' }),
      expect.anything(),
    )
  })
})
