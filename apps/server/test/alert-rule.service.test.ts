import { describe, expect, it, vi } from 'vitest'

// @Transactional 属框架职责（真实事务需 DataSource），mock 为 no-op（其余 kits 导出保留）
vi.mock('@repo/kits', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@repo/kits')>()
  return { ...actual, Transactional: () => () => () => {} }
})

import { AlertRuleService } from '../src/modules/monitor/alert-rule.service.js'
import {
  AlertRuleNameTakenError,
  AlertRuleNotFoundError,
} from '../src/modules/monitor/errors.js'
import type { AlertRuleRepository } from '../src/modules/monitor/alert-rule.repository.js'
import type { AlertRuleEntity } from '../src/database/entities/alert-rule-entity.js'
import { testLogger } from './helpers/logger.js'

type RuleRecord = Omit<AlertRuleEntity, 'deletedAt' | 'generateId'>

const mockRule = (overrides: Partial<RuleRecord> = {}): RuleRecord => ({
  id: 'rule-1',
  name: '登录失败告警',
  type: 'business',
  matchCodes: [1002],
  keywords: [],
  level: 'error',
  channels: ['lark'],
  throttleSeconds: 60,
  enabled: true,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
})

const createService = (repo: Partial<AlertRuleRepository>) =>
  new AlertRuleService(repo as AlertRuleRepository, testLogger())

describe('AlertRuleService（告警规则 CRUD）', () => {
  it('create：名称唯一通过时创建', async () => {
    const repo = {
      findByName: vi.fn(async () => null),
      create: vi.fn(async (data) => mockRule(data)),
    }
    const service = createService(repo)

    const rule = await service.create({
      name: '登录失败告警',
      type: 'business',
      matchCodes: [1002],
      keywords: [],
      level: 'error',
      channels: ['lark'],
      throttleSeconds: 60,
      enabled: true,
    })

    expect(rule.name).toBe('登录失败告警')
    expect(repo.findByName).toHaveBeenCalledWith('登录失败告警')
  })

  it('create：名称重复抛 AlertRuleNameTakenError（3102）', async () => {
    const repo = {
      findByName: vi.fn(async () => mockRule()),
      create: vi.fn(),
    }
    const service = createService(repo)

    await expect(
      service.create({
        name: '登录失败告警',
        type: 'business',
        matchCodes: [],
        keywords: [],
        level: 'error',
        channels: ['lark'],
        throttleSeconds: 60,
        enabled: true,
      }),
    ).rejects.toMatchObject({ code: 3102 })
  })

  it('get：规则不存在抛 AlertRuleNotFoundError（3101）', async () => {
    const repo = { findById: vi.fn(async () => null) }
    const service = createService(repo)

    await expect(service.get({ ruleId: 'nope' })).rejects.toMatchObject({
      code: 3101,
    })
  })

  it('update：改名为他人已占用名称抛 3102', async () => {
    const repo = {
      findByName: vi.fn(async () => mockRule({ id: 'other' })),
      update: vi.fn(),
    }
    const service = createService(repo)

    await expect(
      service.update({ ruleId: 'rule-1', name: '被占用名' }),
    ).rejects.toMatchObject({ code: 3102 })
  })

  it('update：规则不存在抛 3101', async () => {
    const repo = {
      findByName: vi.fn(async () => null),
      update: vi.fn(async () => null),
    }
    const service = createService(repo)

    await expect(service.update({ ruleId: 'nope', enabled: false })).rejects.toMatchObject({
      code: 3101,
    })
  })

  it('remove：规则不存在抛 3101', async () => {
    const repo = { remove: vi.fn(async () => null) }
    const service = createService(repo)

    await expect(service.remove({ ruleId: 'nope' })).rejects.toMatchObject({
      code: 3101,
    })
  })
})
