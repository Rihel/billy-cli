/**
 * 技能可见集合（`docs/design/workspace-cli-credentials.md` §6.7.1 / §6.7.2）。
 *
 * 物化按 **caller** 过滤，别人的个人技能不会进入我的容器：
 * - 内置技能（`source='builtin'`）：全员可见；
 * - 平台导入 / 在线创建：默认不可见，需 `ai_skill_grants` 显式授予（`principal_type='all'` 表示全员）；
 * - 个人技能：仅 owner 本人可见；
 * - 超管（`god`）可看全部平台技能；
 * - **同名冲突个人优先**：物化时个人技能覆盖同名平台技能目录。
 */
export interface SkillRow {
  key: string
  name: string
  description: string
  source: string
  scope: string
  ownerType: string | null
  ownerId: string | null
  files: { path: string; content: string }[]
}

export interface SkillGrantRow {
  skillKey: string
  principalType: string
  principalId: string
}

export interface SkillCaller {
  ownerType: 'user' | 'admin'
  ownerId: string
  /** 仅管理员有意义；`god` 看全部平台技能 */
  adminType?: 'normal' | 'god'
}

export const visibleSkillsOf = (
  skills: SkillRow[],
  grants: SkillGrantRow[],
  caller: SkillCaller,
): SkillRow[] => {
  const granted = new Set(
    grants
      .filter(
        (grant) =>
          grant.principalType === 'all' ||
          (grant.principalType === caller.ownerType && grant.principalId === caller.ownerId),
      )
      .map((grant) => grant.skillKey),
  )
  const isGod = caller.ownerType === 'admin' && caller.adminType === 'god'

  const platform = new Map<string, SkillRow>()
  const personal = new Map<string, SkillRow>()
  for (const skill of skills) {
    if (skill.scope === 'personal') {
      if (skill.ownerType === caller.ownerType && skill.ownerId === caller.ownerId) {
        personal.set(skill.key, skill)
      }
      continue
    }
    // 平台技能：内置全员、其余需授予；超管全量
    if (isGod || skill.source === 'builtin' || granted.has(skill.key)) {
      platform.set(skill.key, skill)
    }
  }

  // 个人优先：同名时用个人的目录覆盖平台的
  return [...new Map([...platform, ...personal]).values()]
}
