import { describe, expect, it } from 'vitest'
import { requestContext, type RequestContextData } from '@repo/kits'
import { AdminType } from '@repo/shared'
import { currentAdminType, currentOwner, scopeOf } from '../src/common/security/owner.js'

/** 在给定身份下执行（requestContext 是 AsyncLocalStorage，测试里手动开一个 run） */
const runAs = <T>(ctx: Partial<RequestContextData>, fn: () => T): T =>
  requestContext.run({ requestId: 'test', userId: null, adminId: null, ...ctx }, fn)

/**
 * 归属换算（`docs/design/workspace-cli-credentials.md` §9.1）。
 *
 * 两个口径必须钉死：**有 userId 就是 user**（前台优先），只有 adminId 才是 admin；
 * 过滤条件一律经 `scopeOf` 收敛，超管不带过滤。
 */
describe('身份 → 归属主体', () => {
  it('有 userId 即前台用户，即使同时有 adminId 也以前台为准', () => {
    expect(runAs({ userId: 'u1', adminId: 'a1' }, currentOwner)).toEqual({
      ownerType: 'user',
      ownerId: 'u1',
    })
  })

  it('只有 adminId 才是管理员', () => {
    expect(runAs({ adminId: 'a1' }, currentOwner)).toEqual({ ownerType: 'admin', ownerId: 'a1' })
  })

  it('没有身份是编程错误，不静默返回空 id', () => {
    expect(() => runAs({}, currentOwner)).toThrow('Authenticated request context is unavailable')
  })
})

describe('scopeOf：归属过滤的唯一入口', () => {
  it('普通管理员只过滤自己的（两个字段一起出现）', () => {
    const scope = runAs({ adminId: 'a1', adminType: AdminType.Normal }, () =>
      scopeOf({ ownerType: 'admin', ownerId: 'a1' }),
    )
    expect(scope).toEqual({ ownerType: 'admin', ownerId: 'a1' })
  })

  it('前台用户同样只过滤自己的', () => {
    const scope = runAs({ userId: 'u1' }, () => scopeOf({ ownerType: 'user', ownerId: 'u1' }))
    expect(scope).toEqual({ ownerType: 'user', ownerId: 'u1' })
  })

  it('超管不带过滤（跨主体可见）', () => {
    const scope = runAs({ adminId: 'god1', adminType: AdminType.God }, () =>
      scopeOf({ ownerType: 'admin', ownerId: 'god1' }),
    )
    expect(scope).toEqual({})
  })

  it('未登记类型的旧上下文按普通管理员处理（最小权限）', () => {
    expect(runAs({ adminId: 'a1' }, currentAdminType)).toBe(AdminType.Normal)
  })
})
