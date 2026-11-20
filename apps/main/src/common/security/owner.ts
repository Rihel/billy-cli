import { requestContext } from '@repo/kits'
import { toAdminType, type AdminTypeValue } from '@repo/shared'

/** 归属主体类型：前台用户 / 后台管理员（与 `ai_workspaces.owner_type` 取值一致） */
export type OwnerType = 'user' | 'admin'

/** 归属主体：任何按人持有的资产（工作区 / 凭据 / 技能 / 会话）都用它定位归属 */
export interface OwnerRef {
  ownerType: OwnerType
  ownerId: string
}

/**
 * 归属过滤条件：普通管理员 / 用户只看到自己的，超管不带任何过滤。
 *
 * `{}` 表示不过滤（超管）；其余情况下两个字段一起出现，避免出现"只按 id 不按类型"的
 * 半截条件（用户 id 与管理员 id 同为 nanoid(20)，只按 id 过滤等于跨体系串号）。
 */
export interface OwnerScope {
  ownerType?: OwnerType
  ownerId?: string
}

/**
 * 当前身份 → 归属主体。
 *
 * 口径（与 `requestContext` 的写入顺序一致）：**存在 `userId` 即为前台用户**，
 * 只有 `adminId` 才是管理员。两套身份体系互不相通，不存在同时登录。
 */
export const currentOwner = (): OwnerRef => {
  const userId = requestContext.get('userId')
  if (userId) return { ownerType: 'user', ownerId: userId }
  const adminId = requestContext.get('adminId')
  if (adminId) return { ownerType: 'admin', ownerId: adminId }
  // 守卫放行了却没写身份，是编程错误，不是"没登录"
  throw new Error('Authenticated request context is unavailable')
}

/** 当前管理员类型；前台用户 / 未登录一律按 `normal`（最小权限） */
export const currentAdminType = (): AdminTypeValue => toAdminType(requestContext.get('adminType'))

/**
 * 归属过滤的**唯一入口**（`docs/design/workspace-cli-credentials.md` §6.10）。
 *
 * 所有按 owner 过滤的查询都从这里取条件，禁止在业务代码里散写 `if (isGod)`：
 * 散布的分支迟早出现"某个 List 忘了判断"，而唯一的函数只有一处可审。
 */
export const scopeOf = (owner: OwnerRef): OwnerScope =>
  currentAdminType() === 'god' ? {} : { ownerType: owner.ownerType, ownerId: owner.ownerId }
