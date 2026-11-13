import type { EntitySubscriberInterface, InsertEvent, SoftRemoveEvent, UpdateEvent } from 'typeorm'
import { AuditEntity } from './audit-entity.js'
import { nanoid } from '@repo/shared'

/** 取当前操作人 id 的钩子（由应用层注入，如请求上下文中的 userId） */
export type AuditUserProvider = () => string | undefined

let auditUserProvider: AuditUserProvider | undefined

/**
 * 注入「当前操作人」来源，供 {@link AuditSubscriber} 自动填充 createdBy / updatedBy / deletedBy。
 *
 * 为什么用模块级钩子而不是 DI：TypeORM 自己实例化 subscriber（无构造器注入），
 * 因此无法通过 Nest 容器把请求上下文传进去。应用层在启动时挂一次即可：
 *
 *   setAuditUserProvider(() => requestContext.get('userId'))
 *
 * 未挂载时统一记为 'system'。
 */
export const setAuditUserProvider = (provider?: AuditUserProvider): void => {
  auditUserProvider = provider
}

/** 读取当前操作人（无上下文时回落 'system'） */
export const getAuditUser = (): string => auditUserProvider?.() || 'system'

/**
 * 审计订阅者（TypeORM EntitySubscriber）：对继承 {@link AuditEntity} 的实体自动写入操作人。
 *
 * 注册方式（Db 配置，无需 DI）：
 *   db: { entities: [...], subscribers: [AuditSubscriber] }
 *
 * 说明：本订阅者不覆盖 id 生成（BaseEntity 的 @BeforeInsert 已负责），只补审计字段。
 */
export class AuditSubscriber implements EntitySubscriberInterface<AuditEntity> {
  /** 仅监听 AuditEntity 及其子类 */
  listenTo(): typeof AuditEntity {
    return AuditEntity
  }

  beforeInsert(event: InsertEvent<AuditEntity>): void {
    const entity = event.entity
    if (!entity) return
    if (!entity.id) entity.id = nanoid()
    const user = getAuditUser()
    entity.createdBy = user
    entity.updatedBy = user
  }

  beforeUpdate(event: UpdateEvent<AuditEntity>): void {
    const entity = event.entity as AuditEntity | undefined
    if (!entity) return
    entity.updatedBy = getAuditUser()
  }

  beforeSoftRemove(event: SoftRemoveEvent<AuditEntity>): void {
    const entity = event.entity
    if (!entity) return
    const user = getAuditUser()
    entity.updatedBy = user
    entity.deletedBy = user
  }
}
