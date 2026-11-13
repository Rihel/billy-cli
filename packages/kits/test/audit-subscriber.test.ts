import { afterEach, describe, expect, it } from 'vitest'
import { AuditSubscriber, getAuditUser, setAuditUserProvider } from '../src/db/audit-subscriber.js'
import type { AuditEntity } from '../src/db/audit-entity.js'

const makeEntity = (): AuditEntity =>
  ({ id: '', createdBy: null, updatedBy: null, deletedBy: null }) as AuditEntity

const subscriber = new AuditSubscriber()
/** 订阅者由 TypeORM 实例化（无构造器注入），事件对象手工构造即可 */
const asEvent = <T>(entity: T) => ({ entity }) as never

afterEach(() => {
  setAuditUserProvider(undefined)
})

describe('审计订阅者（AuditSubscriber）', () => {
  it('未挂载操作人来源时回落 system', () => {
    expect(getAuditUser()).toBe('system')
  })

  it('beforeInsert：补 id 与 createdBy / updatedBy', () => {
    setAuditUserProvider(() => 'user-1')
    const entity = makeEntity()

    subscriber.beforeInsert(asEvent(entity))

    expect(entity.id).not.toBe('')
    expect(entity.createdBy).toBe('user-1')
    expect(entity.updatedBy).toBe('user-1')
  })

  it('beforeInsert：已有 id 不覆盖', () => {
    setAuditUserProvider(() => 'user-1')
    const entity = makeEntity()
    entity.id = 'keep-me'

    subscriber.beforeInsert(asEvent(entity))

    expect(entity.id).toBe('keep-me')
  })

  it('beforeUpdate：只更新 updatedBy', () => {
    setAuditUserProvider(() => 'user-2')
    const entity = makeEntity()

    subscriber.beforeUpdate(asEvent(entity))

    expect(entity.updatedBy).toBe('user-2')
    expect(entity.createdBy).toBeNull()
  })

  it('beforeSoftRemove：记录 updatedBy 与 deletedBy', () => {
    setAuditUserProvider(() => 'user-3')
    const entity = makeEntity()

    subscriber.beforeSoftRemove(asEvent(entity))

    expect(entity.updatedBy).toBe('user-3')
    expect(entity.deletedBy).toBe('user-3')
  })
})
