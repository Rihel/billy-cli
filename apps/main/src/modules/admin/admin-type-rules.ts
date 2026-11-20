import { AdminType } from '@repo/shared'
import type { AdminActor } from './admin.types.js'
import { AdminTypeForbiddenError, LastGodAdminRequiredError } from './errors.js'

/**
 * 管理员类型的权限规则（`docs/design/workspace-cli-credentials.md` §6.10）。
 *
 * 抽成纯函数的原因：这几条是**安全不变量**（谁能提超管、超管不能被降光），
 * 值得脱离数据库直接测；混在带 `@Transactional` 的 service 方法里只能连库测，
 * 测的又恰好不是库行为。
 */

/** 创建：只有超管调用方（或系统调用）能造超管 */
export const assertCanCreateAdminType = (
  actor: AdminActor | undefined,
  requested: string | undefined,
): void => {
  if (requested !== AdminType.God) return
  if (actor && actor.adminType !== AdminType.God) throw new AdminTypeForbiddenError()
}

/**
 * 修改：类型要变时的两道闸门。
 *
 * 1. **谁能改**：普通管理员改任何人的类型都拒绝（包括把自己提成超管）；
 * 2. **不能没有超管**：把 `god` 降级时，全库活着的超管必须 ≥ 2（含被操作者自己）。
 */
export const assertCanChangeAdminType = (input: {
  actor: AdminActor | undefined
  currentType: string
  nextType: string
  livingGods: number
}): void => {
  if (input.nextType === input.currentType) return
  if (input.actor && input.actor.adminType !== AdminType.God) throw new AdminTypeForbiddenError()
  if (input.currentType === AdminType.God) assertAnotherAdminGod(input.livingGods)
}

/** 删除 / 降级：至少还要留一个**其他**超管（`livingGods` 含被操作者自己） */
export const assertAnotherAdminGod = (livingGods: number): void => {
  if (livingGods <= 1) throw new LastGodAdminRequiredError()
}
