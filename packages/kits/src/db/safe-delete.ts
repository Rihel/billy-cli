import type { EntityManager, EntityTarget, FindOptionsWhere } from 'typeorm'
import type { AuditEntity } from './audit-entity.js'

/**
 * 软删除并记录操作人。
 *
 * 顺序很关键：**先**把操作人写进 `deletedBy` / `updatedBy`，**再**执行 `softDelete`
 * —— 反过来的话 TypeORM 的软删本身是 UPDATE 语句，会把刚写的操作人覆盖掉。
 *
 * 类型上把实体收窄为 `AuditEntity`：目标实体没有审计列时应在编译期报错，
 * 而不是运行时静默写不存在的列。
 *
 * 操作人由调用方传入（kits 不依赖 request-context，保持依赖方向 `kits → shared`）。
 *
 * @param operatorId 操作人 id，系统操作传 `'system'`
 * @param where 定位条件（通常按 id 或唯一键）
 */
export async function safeDelete<T extends AuditEntity>(
  manager: EntityManager,
  entityType: EntityTarget<T>,
  where: FindOptionsWhere<T>,
  operatorId: string,
): Promise<void> {
  await manager.update(entityType, where, {
    deletedBy: operatorId,
    updatedBy: operatorId,
  })
  await manager.softDelete(entityType, where)
}
