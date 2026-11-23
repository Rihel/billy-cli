import { createHash } from 'node:crypto'

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
  /** 技能内容哈希（`ai_skills.content_hash`）：算可见集合版本用，不需要拉正文 */
  contentHash?: string | null
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

/**
 * 技能集合版本（`docs/design/workspace-cli-credentials.md` §6.7.4）：
 * 可见技能的 `key + contentHash` 排序后 sha256 前 16 位。
 *
 * 为什么要有它：`ensure` 只在「新建容器」或「main 推送」时物化技能，
 * 技能在「工作区没在跑」时新增 / 改动后，`.agents/` 永远不会更新。
 * 版本写进 `.billy/setup.json`，每次 ensure 比对，落后才补 —— 便宜且可自愈。
 *
 * 缺哈希（历史行 / 未 seed）按空串算：只会让版本变化一次，seed 补上哈希后自然收敛。
 */
export const skillSetVersionOf = (
  skills: readonly { key: string; contentHash?: string | null }[],
): string => {
  const rows = [...skills].map((skill) => `${skill.key}:${skill.contentHash ?? ''}`).sort()
  return createHash('sha256').update(rows.join('\n')).digest('hex').slice(0, 16)
}
