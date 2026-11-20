import { requestContext } from '@repo/kits'
import { toAdminType } from '@repo/shared'

/**
 * 技能写入目标（`docs/design/workspace-cli-credentials.md` §6.7.1 / D12）。
 *
 * **由调用方身份决定，不由入参 `scope` 决定**：否则任意调用方都能污染平台技能库。
 * - 前台用户：一律落到 `personal` + 自身 owner；
 * - 管理员：`god` 可指定平台技能，普通管理员写到自己的 `personal`；
 * - 系统 / 脚本（无请求上下文）：沿用历史口径落到 `platform`（迁移期与种子用）。
 */
export interface SkillWriteTarget {
  scope: 'platform' | 'personal'
  ownerType: 'user' | 'admin' | null
  ownerId: string | null
}

export interface SkillCaller {
  ownerType: 'user' | 'admin'
  ownerId: string
  adminType?: 'normal' | 'god'
}

/** 当前请求的调用方（无请求上下文 = 系统 / 脚本） */
export const currentSkillCaller = (): SkillCaller | null => {
  const userId = requestContext.get('userId')
  if (userId) return { ownerType: 'user', ownerId: userId }
  const adminId = requestContext.get('adminId')
  if (!adminId) return null
  return {
    ownerType: 'admin',
    ownerId: adminId,
    adminType: toAdminType(requestContext.get('adminType')),
  }
}

export const resolveSkillWriteTarget = (
  caller: SkillCaller | null,
  /** god 可显式选「平台 / 个人」；其他身份忽略该值（防止提权） */
  requested?: 'platform' | 'personal',
): SkillWriteTarget => {
  if (!caller) return { scope: 'platform', ownerType: null, ownerId: null }
  if (caller.ownerType === 'user') {
    return { scope: 'personal', ownerType: 'user', ownerId: caller.ownerId }
  }
  if (caller.adminType === 'god') {
    return requested === 'personal'
      ? { scope: 'personal', ownerType: 'admin', ownerId: caller.ownerId }
      : { scope: 'platform', ownerType: null, ownerId: null }
  }
  return { scope: 'personal', ownerType: 'admin', ownerId: caller.ownerId }
}

/** 可见行（技能实体 / 详情等只需这三个字段） */
export interface ScopedSkillRow {
  scope: string
  ownerType: string | null
  ownerId: string | null
}

/**
 * 在同一个 `skill_key` 的多行里选出**调用方可见的那一行**。
 *
 * 口径（§6.7.1）：个人技能优先于平台同名技能（物化时也是个人覆盖平台）；
 * 别人的个人技能对普通用户 / 普通管理员不可见；无上下文（系统）只看平台。
 * `god` 的"跨主体查看"需要落审计，留待权限矩阵那一步再接，这里先不放开。
 */
export const pickVisibleSkill = <T extends ScopedSkillRow>(
  rows: T[],
  caller: SkillCaller | null,
): T | null => {
  const mine = caller
    ? rows.find(
        (row) =>
          row.scope === 'personal' &&
          row.ownerType === caller.ownerType &&
          row.ownerId === caller.ownerId,
      )
    : undefined
  if (mine) return mine
  return rows.find((row) => row.scope === 'platform') ?? null
}
