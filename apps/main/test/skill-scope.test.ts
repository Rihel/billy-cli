import { describe, expect, it } from 'vitest'
import { resolveSkillWriteTarget } from '../src/modules/ai-admin/skill/skill-scope.js'

const god = { ownerType: 'admin' as const, ownerId: 'a1', adminType: 'god' as const }
const normal = { ownerType: 'admin' as const, ownerId: 'a2', adminType: 'normal' as const }

/** god 可选平台 / 个人；普通管理员一律个人（防提权） */
describe('resolveSkillWriteTarget', () => {
  it('god 默认平台，要求个人时写自己名下', () => {
    expect(resolveSkillWriteTarget(god)).toEqual({
      scope: 'platform',
      ownerType: null,
      ownerId: null,
    })
    expect(resolveSkillWriteTarget(god, 'personal')).toEqual({
      scope: 'personal',
      ownerType: 'admin',
      ownerId: 'a1',
    })
  })

  it('普通管理员忽略 platform 请求，仍写个人', () => {
    expect(resolveSkillWriteTarget(normal, 'platform')).toEqual({
      scope: 'personal',
      ownerType: 'admin',
      ownerId: 'a2',
    })
  })

  it('无上下文（系统）只写平台', () => {
    expect(resolveSkillWriteTarget(null, 'personal').scope).toBe('platform')
  })
})
