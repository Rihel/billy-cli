import { describe, expect, it, vi } from 'vitest'
import type { MonitorAlertEntity } from '../src/database/entities/monitor-alert-entity.js'
import type { MonitorRuleEntity } from '../src/database/entities/monitor-rule-entity.js'
import { AlertLifecycleService } from '../src/modules/monitor/engine/alert-lifecycle.service.js'
import type { AlertRepository } from '../src/modules/monitor/engine/alert.repository.js'
import { httpErrorRateRule } from '../src/modules/monitor/rules/system/http-error-rate.rule.js'
import { uncaughtExceptionRule } from '../src/modules/monitor/rules/system/uncaught-exception.rule.js'
import type { Hit } from '../src/modules/monitor/definitions/rule.types.js'
import type { MonitorRuleConfig } from '@repo/shared'

const config: MonitorRuleConfig = {
  enabled: true,
  operator: 'gt',
  threshold: 0.05,
  channels: ['file'],
  silenceSeconds: 300,
  level: 'error',
  recoverAfterWindows: 2,
}

const window = {
  key: '2026-10-21T14:31:00.000Z',
  start: new Date('2026-10-21T14:31:00.000Z'),
  end: new Date('2026-10-21T14:32:00.000Z'),
}

const alert = (overrides: Partial<MonitorAlertEntity> = {}): MonitorAlertEntity =>
  ({
    id: 'alert-1',
    ruleKey: 'system.http.error-rate',
    kind: 'metric',
    ruleName: 'HTTP 错误率过高',
    level: 'error',
    subjectId: 'instance:a',
    instanceId: 'a',
    status: 'firing',
    firstFiredAt: new Date('2026-10-21T14:30:00.000Z'),
    lastFiredAt: new Date('2026-10-21T14:31:00.000Z'),
    recoveredAt: null,
    durationMs: null,
    missCount: 0,
    value: 0.2,
    threshold: 0.05,
    windowKey: window.key,
    firstSnapshot: null,
    lastSnapshot: null,
    ...overrides,
  }) as MonitorAlertEntity

const hit = (): Hit => ({
  ruleKey: 'system.http.error-rate',
  subjectId: 'instance:a',
  value: 0.2,
  threshold: 0.05,
  windowStart: window.start,
  windowEnd: window.end,
  samples: [
    {
      metricKey: 'request.errorRate',
      metricKind: 'derived',
      windowKey: window.key,
      windowStart: window.start,
      windowEnd: window.end,
      instanceId: 'a',
      dimensionType: 'total',
      dimensionKey: '',
      value: 0.2,
    },
  ],
})

describe('AlertLifecycleService（首次 / 恢复 / 快照）', () => {
  it('首次命中：创建 firing 记录，写首次快照和级别', async () => {
    const repo = {
      findOpenByRule: vi.fn().mockResolvedValue([]),
      upsertFiring: vi.fn().mockResolvedValue(alert()),
      markMiss: vi.fn(),
      resolve: vi.fn(),
      resolveByRule: vi.fn(),
    }
    const service = new AlertLifecycleService(repo as unknown as AlertRepository)

    const items = await service.reconcileMetric(
      httpErrorRateRule,
      {} as MonitorRuleEntity,
      config,
      [hit()],
      window,
      new Date('2026-10-21T14:32:00.000Z'),
      'leader',
    )

    expect(items).toHaveLength(1)
    const input = repo.upsertFiring.mock.calls[0][0]
    expect(input).toMatchObject({
      ruleKey: 'system.http.error-rate',
      kind: 'metric',
      level: 'error',
      subjectId: 'instance:a',
      instanceId: 'a',
      value: 0.2,
      threshold: 0.05,
    })
    expect(input.snapshot).toMatchObject({
      kind: 'metric',
      operator: 'gt',
      threshold: 0.05,
    })
  })

  it('连续未命中达到阈值后恢复，并写 recoveredAt / durationMs', async () => {
    const open = alert()
    const repo = {
      findOpenByRule: vi.fn().mockResolvedValue([open]),
      upsertFiring: vi.fn(),
      markMiss: vi.fn().mockResolvedValue(2),
      resolve: vi.fn().mockResolvedValue(undefined),
      resolveByRule: vi.fn(),
    }
    const service = new AlertLifecycleService(repo as unknown as AlertRepository)

    await service.reconcileMetric(
      httpErrorRateRule,
      {} as MonitorRuleEntity,
      config,
      [],
      window,
      new Date('2026-10-21T14:33:00.000Z'),
      'leader',
    )

    expect(repo.markMiss).toHaveBeenCalledWith('alert-1')
    expect(repo.resolve).toHaveBeenCalledWith(open, new Date('2026-10-21T14:33:00.000Z'))
  })

  it('事件命中：subject 用错误码，快照带消息并截断长栈', async () => {
    const repo = {
      findOpenByRule: vi.fn(),
      upsertFiring: vi.fn().mockResolvedValue(alert({ kind: 'event', subjectId: 'code:1002' })),
      markMiss: vi.fn(),
      resolve: vi.fn(),
      resolveByRule: vi.fn(),
    }
    const service = new AlertLifecycleService(repo as unknown as AlertRepository)

    await service.createEventAlert(
      uncaughtExceptionRule,
      {} as MonitorRuleEntity,
      config,
      {
        code: 1002,
        message: 'boom',
        stack: 'x'.repeat(5000),
        at: new Date('2026-10-21T14:32:00.000Z'),
      },
      3,
      window.key,
      new Date('2026-10-21T14:32:00.000Z'),
      'leader',
    )

    const input = repo.upsertFiring.mock.calls[0][0]
    expect(input.kind).toBe('event')
    expect(input.subjectId).toBe('code:1002')
    expect(input.snapshot.kind).toBe('event')
    expect((input.snapshot.stack as string).length).toBeLessThanOrEqual(4001)
  })
})
