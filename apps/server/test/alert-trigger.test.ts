import { beforeEach, describe, expect, it, vi } from 'vitest'

// @Transactional 属框架职责（真实事务需 DataSource），mock 为 no-op（其余 kits 导出保留）
vi.mock('@repo/kits', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@repo/kits')>()
  return { ...actual, Transactional: () => () => () => {} }
})

import { AlertTrigger } from '../src/modules/monitor/alert-trigger.js'
import type { AlertRuleRepository } from '../src/modules/monitor/alert-rule.repository.js'
import type { AlertLogRepository } from '../src/modules/monitor/alert-log.repository.js'
import type { Notifier } from '@repo/kits'
import type { LarkNotifyClient, EmailClient } from '@repo/kits'
import type { AlertRuleEntity } from '../src/database/entities/alert-rule-entity.js'

const mockRule = (overrides: Partial<AlertRuleEntity> = {}): AlertRuleEntity =>
  ({
    id: 'rule-1',
    name: '业务错误告警',
    type: 'business',
    matchCodes: [1002],
    keywords: [],
    level: 'error',
    channels: ['lark', 'email'],
    throttleSeconds: 60,
    enabled: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    ...overrides,
  }) as AlertRuleEntity

const createService = (overrides: {
  enabled?: boolean
  rules?: AlertRuleEntity[]
  sendResult?: { ok: boolean; error?: string }
  snapshot?: Parameters<Telemetry['snapshot']>[0]
} = {}) => {
  const { enabled = true, rules = [], sendResult = { ok: true } } = overrides
  const ruleRepository = {
    findAllEnabled: vi.fn(async () => rules),
  } as unknown as AlertRuleRepository
  const logRepository = {
    save: vi.fn(async (data: unknown) => ({ ...(data as object), id: 'log-1' })),
  } as unknown as AlertLogRepository
  const notifier = {
    send: vi.fn(async () => sendResult),
  } as unknown as Notifier
  const fileClient = { configured: true, send: vi.fn() } as unknown as FileClient
  const larkNotify = { configured: true, send: vi.fn() } as unknown as LarkNotifyClient
  const email = { configured: true, send: vi.fn() } as unknown as EmailClient
  const snapshot = {
    windowSeconds: 60,
    windowStartAt: Date.now(),
    previousWindowStartAt: null,
    counters: {},
    previousCounters: {},
    gauges: {},
    histograms: {},
    ...(overrides.snapshot ?? {}),
  } as unknown as TelemetrySnapshot
  const telemetry = { snapshot: vi.fn(() => snapshot) } as unknown as Telemetry
  const evalHandlers: Array<() => Promise<void>> = []
  const scheduler = {
    scheduleInterval: vi.fn((_name: string, _ms: number, handler: () => void) => {
      evalHandlers.push(async () => handler())
    }),
  } as unknown as Scheduler
  const service = new AlertTrigger(
    { enabled, emailTo: 'ops@corp.com' },
    ruleRepository,
    logRepository,
    notifier,
    telemetry,
    scheduler,
    fileClient,
    larkNotify,
    email,
  )
  return { service, ruleRepository, logRepository, notifier, fileClient, larkNotify, email, telemetry, evalHandlers }
}

describe('AlertTrigger（规则匹配 → 限频 → 通知 → 落审计）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('告警开关关闭：不匹配规则、不发送、不落库', async () => {
    const { service, ruleRepository, notifier, logRepository } = createService({ enabled: false })
    await service.notifyError(new Error('boom'))
    expect(ruleRepository.findAllEnabled).not.toHaveBeenCalled()
    expect(notifier.send).not.toHaveBeenCalled()
    expect(logRepository.save).not.toHaveBeenCalled()
  })

  it('规则命中（matchCodes 含错误码）：按规则通道发送并逐通道落审计', async () => {
    const { service, notifier, logRepository } = createService({ rules: [mockRule()] })
    const error = Object.assign(new Error('邮箱或密码错误'), { code: 1002 })

    await service.notifyError(error, { path: '/auth/login', requestId: 'req-1' })

    expect(notifier.send).toHaveBeenCalledTimes(2) // lark + email
    expect(notifier.send).toHaveBeenCalledWith('lark', expect.objectContaining({ content: expect.stringContaining('请求路径：/auth/login') }))
    expect(notifier.send).toHaveBeenCalledWith('email', {
      to: 'ops@corp.com',
      subject: expect.stringContaining('1002'),
      text: expect.stringContaining('req-1'),
    })
    expect(logRepository.save).toHaveBeenCalledTimes(2)
    expect(logRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({ ruleId: 'rule-1', ruleName: '业务错误告警', status: 'success' }),
    )
  })

  it('规则不命中（错误码不在 matchCodes）：不发送', async () => {
    const { service, notifier } = createService({ rules: [mockRule()] })
    await service.notifyError(Object.assign(new Error('x'), { code: 9999 }))
    expect(notifier.send).not.toHaveBeenCalled()
  })

  it('关键字匹配：message 含任一关键字即命中', async () => {
    const { service, notifier } = createService({
      rules: [mockRule({ matchCodes: [], keywords: ['数据库'] })],
    })
    await service.notifyError(new Error('连接数据库超时'))
    expect(notifier.send).toHaveBeenCalled()
  })

  it('无规则匹配：默认技术规则兜底（配置启用的通道）', async () => {
    const { service, notifier, logRepository } = createService({ rules: [] })
    await service.notifyError(new Error('未捕获异常'))
    expect(notifier.send).toHaveBeenCalledTimes(3) // file + lark + email（configured）
    expect(logRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({ ruleId: null, ruleName: '默认技术告警' }),
    )
  })

  it('限频：同规则同内容在窗口内只发一次', async () => {
    const { service, notifier } = createService({ rules: [mockRule({ throttleSeconds: 60 })] })
    const error = Object.assign(new Error('邮箱或密码错误'), { code: 1002 })

    await service.notifyError(error)
    await service.notifyError(error)

    expect(notifier.send).toHaveBeenCalledTimes(2) // 第一次 lark+email；第二次全部被限频
  })

  it('限频：requestId / path 等上下文变化不影响去重（同一错误仍拦截）', async () => {
    const { service, notifier } = createService({ rules: [mockRule({ throttleSeconds: 60 })] })
    const error = Object.assign(new Error('邮箱或密码错误'), { code: 1002 })

    await service.notifyError(error, { path: '/auth/login', requestId: 'req-1' })
    await service.notifyError(error, { path: '/auth/login', requestId: 'req-2' })

    expect(notifier.send).toHaveBeenCalledTimes(2) // 第二次（不同 requestId）仍被限频
  })

  it('发送失败：AlertLog 记录 failed 与错误信息', async () => {
    const { service, logRepository } = createService({
      rules: [mockRule({ channels: ['email'] })],
      sendResult: { ok: false, error: 'SMTP 530' },
    })
    await service.notifyError(Object.assign(new Error('x'), { code: 1002 }))
    expect(logRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed', error: 'SMTP 530' }),
    )
  })

  it('落库失败不抛错（不影响调用方）', async () => {
    const { service, notifier } = createService({ rules: [mockRule({ channels: ['email'] })] })
    const logRepository = {
      save: vi.fn(async () => {
        throw new Error('db down')
      }),
    } as unknown as AlertLogRepository
    ;(service as unknown as { logRepository: AlertLogRepository }).logRepository = logRepository

    await expect(service.notifyError(Object.assign(new Error('x'), { code: 1002 }))).resolves.toBeUndefined()
    expect(notifier.send).toHaveBeenCalled()
  })

  it('testNotify：测试告警直接发送并落审计（不限频）', async () => {
    const { service, notifier, logRepository } = createService()
    await service.testNotify({ title: '测试', message: '验证通道', channels: ['lark'] })
    expect(notifier.send).toHaveBeenCalledWith('lark', { content: expect.stringContaining('验证通道') })
    expect(logRepository.save).toHaveBeenCalled()
  })

  it('事件规则次数阈值：窗口内未达 threshold 不告警，达到才发送', async () => {
    const { service, notifier } = createService({
      rules: [mockRule({ threshold: 3, thresholdWindowSeconds: 60, channels: ['email'] })],
    })
    const error = Object.assign(new Error('邮箱或密码错误'), { code: 1002 })

    await service.notifyError(error) // 第 1 次
    await service.notifyError(error) // 第 2 次
    expect(notifier.send).not.toHaveBeenCalled()

    await service.notifyError(error) // 第 3 次：达到阈值
    expect(notifier.send).toHaveBeenCalledTimes(1)
  })

  it('事件规则阈值窗口过期：重新计数', async () => {
    const { service, notifier } = createService({
      rules: [mockRule({ threshold: 2, thresholdWindowSeconds: 1, channels: ['email'] })],
    })
    const error = Object.assign(new Error('邮箱或密码错误'), { code: 1002 })
    await service.notifyError(error) // 计数 1
    // 模拟窗口过期（>1s）后再次触发
    const trigger = service as unknown as { eventCounts: Map<string, { count: number; windowStart: number }> }
    const key = trigger.eventCounts.keys().next().value as string
    trigger.eventCounts.get(key)!.windowStart = Date.now() - 2000
    await service.notifyError(error) // 新窗口计数 1（< 2 不告警）
    expect(notifier.send).not.toHaveBeenCalled()
  })

  it('metric 规则：周期评估错误率超阈值 → 发送告警', async () => {
    const { service, notifier, evalHandlers } = createService({
      rules: [
        mockRule({
          id: 'metric-1',
          name: '错误率过高',
          type: 'metric',
          metric: 'request.errorRate',
          operator: 'gt',
          thresholdValue: 0.05,
          periodSeconds: 60,
          channels: ['email'],
        }),
      ],
      snapshot: { counters: { 'request.count': 100, 'request.error': 12 } },
    })

    await evalHandlers[0]()
    expect(notifier.send).toHaveBeenCalledTimes(1)
    expect(notifier.send).toHaveBeenCalledWith(
      'email',
      expect.objectContaining({ subject: '告警：错误率过高' }),
    )
  })

  it('metric 规则：未超阈值不告警', async () => {
    const { service, notifier, evalHandlers } = createService({
      rules: [
        mockRule({
          id: 'metric-1',
          name: '错误率过高',
          type: 'metric',
          metric: 'request.errorRate',
          operator: 'gt',
          thresholdValue: 0.5,
          periodSeconds: 60,
          channels: ['email'],
        }),
      ],
      snapshot: { counters: { 'request.count': 100, 'request.error': 12 } },
    })
    await evalHandlers[0]()
    expect(notifier.send).not.toHaveBeenCalled()
  })

  it('surge 规则：QPS 环比超倍率 → 发送（洪峰）', async () => {
    const { service, notifier, evalHandlers } = createService({
      rules: [
        mockRule({
          id: 'surge-1',
          name: '请求洪峰',
          type: 'surge',
          metric: 'request.qps',
          operator: 'gt',
          thresholdValue: 3,
          periodSeconds: 60,
          channels: ['email'],
        }),
      ],
      snapshot: {
        counters: { 'request.count': 900 }, // 当前窗口 900 → rate 15
        previousCounters: { 'request.count': 100 }, // 前一窗口 100 → rate ~1.67
      },
    })
    await evalHandlers[0]()
    expect(notifier.send).toHaveBeenCalledTimes(1)
    expect(notifier.send).toHaveBeenCalledWith(
      'email',
      expect.objectContaining({ subject: '告警：请求洪峰' }),
    )
  })

  it('surge 规则：无基线（首个窗口）跳过评估', async () => {
    const { service, notifier, evalHandlers } = createService({
      rules: [
        mockRule({
          id: 'surge-1',
          name: '请求洪峰',
          type: 'surge',
          metric: 'request.qps',
          operator: 'gt',
          thresholdValue: 3,
          periodSeconds: 60,
          channels: ['email'],
        }),
      ],
      snapshot: { counters: { 'request.count': 900 }, previousCounters: {} },
    })
    await evalHandlers[0]()
    expect(notifier.send).not.toHaveBeenCalled()
  })

  it('默认规则兜底：文件输出始终可用（无真实通道配置时写文件）', async () => {
    const { service, notifier } = createService({
      rules: [],
      sendResult: { ok: true },
    })
    // fileClient configured=true → 默认通道含 file
    await service.notifyError(new Error('未捕获异常'))
    expect(notifier.send).toHaveBeenCalledWith('file', expect.anything())
  })
})
