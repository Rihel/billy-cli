import { describe, expect, it } from 'vitest'
import {
  AiToolAuditEntity,
  ConversationEntity,
  DB_ENTITIES,
  DB_MIGRATIONS,
  TimelineEntity,
} from '../src/index.js'

describe('@repo/db', () => {
  it('导出全量实体清单，且包含会话 / 时间线 / 审计', () => {
    expect(DB_ENTITIES).toContain(ConversationEntity)
    expect(DB_ENTITIES).toContain(TimelineEntity)
    expect(DB_ENTITIES).toContain(AiToolAuditEntity)
  })

  it('导出迁移清单，且带 name（TypeORM 按类运行）', () => {
    expect(DB_MIGRATIONS.length).toBeGreaterThan(30)
    expect(DB_MIGRATIONS.every((migration) => typeof migration.name === 'string')).toBe(true)
  })
})
