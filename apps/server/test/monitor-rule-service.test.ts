import { describe, expect, it, vi } from 'vitest'
import type { MonitorRuleEntity } from '../src/database/entities/monitor-rule-entity.js'
import { MonitorRuleService } from '../src/modules/monitor/api/monitor-rule.service.js'
import type { AlertLifecycleService } from '../src/modules/monitor/engine/alert-lifecycle.service.js'
import type { AlertRepository } from '../src/modules/monitor/engine/alert.repository.js'
import type { MonitorRuleRepository } from '../src/modules/monitor/engine/monitor-rule.repository.js'
import { RuleRegistry } from '../src/modules/monitor/engine/rule.registry.js'
import { MonitorRuleConfigInvalidError } from '../src/modules/monitor/errors.js'

const row = (): MonitorRuleEntity =>
  ({
    id: 'rule-1',
    ruleKey: 'system.http.error-rate',
    name: 'HTTP 错误率过高',
    description: 'test',
    category: 'system',
    kind: 'metric',
    driver: 'batch',
    metricKey: 'request.errorRate',
    evaluationIntervalSeconds: 60,
    windowSeconds: 60,
    config: {
      enabled: true,
      operator: 'gt',
      threshold: 0.05,
      channels: ['file'],
      silenceSeconds: 300,
      level: 'error',
      recoverAfterWindows: 2,
    },
    definitionVersion: 'v1',
    enabled: true,
    deprecated: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  }) as MonitorRuleEntity

describe('MonitorRuleService（配置合并与校验）', () => {
  it('update 只改传入字段，保留其它配置和通道', async () => {
    const current = row()
    const repo = {
      findByKey: vi.fn().mockResolvedValue(current),
      updateConfig: vi.fn().mockImplementation(async (_key, config, enabled) => ({
        ...current,
        config,
        enabled: enabled ?? current.enabled,
      })),
    }
    const service = new MonitorRuleService(
      new RuleRegistry(),
      repo as unknown as MonitorRuleRepository,
      { lastFiredAt: vi.fn().mockResolvedValue(null) } as unknown as AlertRepository,
      { resolveByRule: vi.fn() } as unknown as AlertLifecycleService,
      { log: vi.fn(), warn: vi.fn() } as never,
    )

    const updated = await service.update({
      ruleKey: 'system.http.error-rate',
      config: { threshold: 0.1 },
    })

    expect(updated.config.threshold).toBe(0.1)
    expect(updated.config.channels).toEqual(['file'])
    expect(updated.config.level).toBe('error')
    expect(repo.updateConfig.mock.calls[0][1]).toMatchObject({
      threshold: 0.1,
      channels: ['file'],
    })
  })

  it('update 拒绝未声明的配置字段', async () => {
    const service = new MonitorRuleService(
      new RuleRegistry(),
      {
        findByKey: vi.fn().mockResolvedValue(row()),
        updateConfig: vi.fn(),
      } as unknown as MonitorRuleRepository,
      { lastFiredAt: vi.fn() } as unknown as AlertRepository,
      { resolveByRule: vi.fn() } as unknown as AlertLifecycleService,
      { log: vi.fn(), warn: vi.fn() } as never,
    )

    await expect(
      service.update({
        ruleKey: 'system.http.error-rate',
        config: { unknownField: 1 },
      }),
    ).rejects.toBeInstanceOf(MonitorRuleConfigInvalidError)
  })
})
