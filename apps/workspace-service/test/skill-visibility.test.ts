import { describe, expect, it } from 'vitest'
import {
  skillSetVersionOf,
  visibleSkillsOf,
  type SkillRow,
} from '../src/workspace/skill-visibility.js'

/**
 * 技能可见集合（§6.7.1 / §6.7.2）。
 *
 * 钉五条：内置全员可见；平台技能默认不可见、授予后可见；个人技能仅 owner；
 * 超管看全部平台技能；同名冲突个人优先。
 */

const skill = (over: Partial<SkillRow> & Pick<SkillRow, 'key'>): SkillRow => ({
  name: over.key,
  description: '',
  source: 'online',
  scope: 'platform',
  ownerType: null,
  ownerId: null,
  files: [{ path: 'SKILL.md', content: over.key }],
  ...over,
})

const USER = { ownerType: 'user' as const, ownerId: 'u_1' }

describe('平台技能', () => {
  it('内置全员可见；在线 / 导入默认不可见', () => {
    const skills = [
      skill({ key: 'builtin-a', source: 'builtin' }),
      skill({ key: 'imported-b', source: 'import' }),
    ]
    expect(visibleSkillsOf(skills, [], USER).map((item) => item.key)).toEqual(['builtin-a'])
  })

  it('授予后可见（principal=本人 或 all）', () => {
    const skills = [skill({ key: 'imported-b', source: 'import' })]
    expect(
      visibleSkillsOf(
        skills,
        [{ skillKey: 'imported-b', principalType: 'user', principalId: 'u_1' }],
        USER,
      ),
    ).toHaveLength(1)
    expect(
      visibleSkillsOf(
        skills,
        [{ skillKey: 'imported-b', principalType: 'all', principalId: '*' }],
        USER,
      ),
    ).toHaveLength(1)
    expect(
      visibleSkillsOf(
        skills,
        [{ skillKey: 'imported-b', principalType: 'user', principalId: 'u_2' }],
        USER,
      ),
    ).toHaveLength(0)
  })

  it('超管看全部平台技能（含未授予的）', () => {
    const skills = [skill({ key: 'imported-b', source: 'import' })]
    expect(
      visibleSkillsOf(skills, [], { ownerType: 'admin', ownerId: 'god_1', adminType: 'god' }),
    ).toHaveLength(1)
    expect(
      visibleSkillsOf(skills, [], { ownerType: 'admin', ownerId: 'adm_1', adminType: 'normal' }),
    ).toHaveLength(0)
  })
})

describe('个人技能', () => {
  const personal = skill({ key: 'mine', scope: 'personal', ownerType: 'user', ownerId: 'u_1' })

  it('仅 owner 可见（别人看不到）', () => {
    expect(visibleSkillsOf([personal], [], USER)).toHaveLength(1)
    expect(visibleSkillsOf([personal], [], { ownerType: 'user', ownerId: 'u_2' })).toHaveLength(0)
  })

  it('同名时个人覆盖平台（物化以个人内容为准）', () => {
    const platform = skill({ key: 'same', source: 'builtin' })
    const mine = skill({
      key: 'same',
      scope: 'personal',
      ownerType: 'user',
      ownerId: 'u_1',
      files: [{ path: 'SKILL.md', content: 'personal' }],
    })
    const visible = visibleSkillsOf([platform, mine], [], USER)
    expect(visible).toHaveLength(1)
    expect(visible[0].files[0].content).toBe('personal')
  })
})

describe('skillSetVersionOf（可见技能集合版本）', () => {
  it('与技能顺序无关：同一份集合永远同一个版本', () => {
    const a = { key: 'a', contentHash: 'h1' }
    const b = { key: 'b', contentHash: 'h2' }
    expect(skillSetVersionOf([a, b])).toBe(skillSetVersionOf([b, a]))
    expect(skillSetVersionOf([a, b])).toHaveLength(16)
  })

  it('内容变化 / 集合增减都会改版本（否则 ensure 永远判「已同步」）', () => {
    const base = skillSetVersionOf([{ key: 'a', contentHash: 'h1' }])
    expect(skillSetVersionOf([{ key: 'a', contentHash: 'h2' }])).not.toBe(base)
    expect(
      skillSetVersionOf([
        { key: 'a', contentHash: 'h1' },
        { key: 'b', contentHash: '' },
      ]),
    ).not.toBe(base)
  })

  it('空集合也有稳定版本（首次初始化可写入）', () => {
    expect(skillSetVersionOf([])).toBe(skillSetVersionOf([]))
    expect(skillSetVersionOf([])).toHaveLength(16)
  })

  it('缺 contentHash 按空串算（历史行 / 未 seed 不会让版本抖动）', () => {
    expect(skillSetVersionOf([{ key: 'a' }])).toBe(
      skillSetVersionOf([{ key: 'a', contentHash: null }]),
    )
  })
})
