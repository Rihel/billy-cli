import { describe, expect, it, vi } from 'vitest'
import type { CapabilityDecl, ToolCaller } from '@repo/contracts'
import type { ToolGatewayConfigValue } from '../src/config/app-config.js'
import { CapabilityPolicyService } from '../src/registry/capability.policy.js'

const config: ToolGatewayConfigValue = {
  internalToken: 'token',
  staleAfterMs: 30_000,
  invokeTimeoutMs: 2_000,
  rateLimitPerMinute: 60,
}

const caller = (over: Partial<ToolCaller> = {}): ToolCaller => ({
  conversationId: 'c-1',
  runId: 'run-1',
  userId: 'u-1',
  isAdmin: false,
  agentKey: 'assistant',
  rootAgentKey: 'assistant',
  depth: 0,
  ...over,
})

const decl = (over: Partial<CapabilityDecl> = {}): CapabilityDecl => ({
  tool: 'bash',
  title: '执行命令',
  description: '跑一条命令',
  inputSchema: {
    type: 'object',
    properties: { command: { type: 'string' } },
    required: ['command'],
  },
  risk: 'write',
  idempotent: false,
  scope: 'all',
  timeoutMs: 30_000,
  pagination: 'none',
  tags: [],
  execution: {
    mode: 'sync',
    owner: 'session',
    yieldMs: 45_000,
    wait: { maxWaitMs: 0 },
    cancel: 'none',
    poll: { minIntervalMs: 1_000 },
    maxRunMs: 1_800_000,
  },
  ...over,
})

const build = (
  over: {
    effective?: Record<string, unknown>
    incr?: number
    /** 模拟 Redis 抖动：incr 直接抛错 */
    incrError?: Error
    capability?: Partial<CapabilityDecl>
  } = {},
) => {
  const redis = {
    incr: over.incrError
      ? vi.fn().mockRejectedValue(over.incrError)
      : vi.fn().mockResolvedValue(over.incr ?? 1),
    expire: vi.fn().mockResolvedValue(true),
  }
  const toolConfig = {
    effective: vi.fn().mockResolvedValue({
      enabled: true,
      scope: null,
      allowedAgents: null,
      config: {},
      limits: {},
      secrets: {},
      version: 'test',
      ...over.effective,
    }),
  }
  const logger = { warn: vi.fn(), error: vi.fn(), log: vi.fn() }
  const service = new CapabilityPolicyService(
    redis as never,
    toolConfig as never,
    config,
    logger as never,
  )
  return { service, redis, toolConfig, logger, capability: decl(over.capability) }
}

describe('CapabilityPolicyService（新调用链的治理）', () => {
  it('放行合法调用，入参原样返回', async () => {
    const { service, capability } = build()
    const result = await service.precheck({ key: 'bash', capability }, caller(), {
      command: 'echo hi',
    })
    expect(result).toEqual({ ok: true, input: { command: 'echo hi' } })
  })

  it('停用的能力直接拒绝', async () => {
    const { service, capability } = build({ effective: { enabled: false } })
    const result = await service.precheck({ key: 'bash', capability }, caller(), {
      command: 'x',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.outcome.reason).toBe('disabled')
  })

  it('admin 作用域挡住普通用户', async () => {
    const { service, capability } = build({ capability: { scope: 'admin' } })
    const result = await service.precheck({ key: 'bash', capability }, caller(), {
      command: 'x',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.outcome.reason).toBe('forbidden')
  })

  it('按注册的 JSON Schema 校验入参', async () => {
    const { service, capability } = build()
    const result = await service.precheck({ key: 'bash', capability }, caller(), {})
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.outcome.reason).toBe('invalid-input')
  })

  it('超限流返回 rate-limited，允许重试', async () => {
    const { service, capability } = build({ incr: 999 })
    const result = await service.precheck({ key: 'bash', capability }, caller(), {
      command: 'x',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.outcome.reason).toBe('rate-limited')
      expect(result.outcome.retryable).toBe(true)
    }
  })

  it('写入类能力：入参校验器用不了就拒绝，不静默放行', async () => {
    const { service, capability } = build({
      capability: { inputSchema: { type: 'object', properties: 'nope' } },
    })
    const result = await service.precheck({ key: 'bash', capability }, caller(), { command: 'x' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.outcome.reason).toBe('validator-unavailable')
  })

  it('只读能力：入参校验器用不了按兼容放行（与旧行为一致）', async () => {
    const { service, capability, logger } = build({
      capability: { risk: 'read', inputSchema: { type: 'object', properties: 'nope' } },
    })
    const result = await service.precheck({ key: 'file-list', capability }, caller(), { path: '/' })
    expect(result.ok).toBe(true)
    expect(logger.warn).toHaveBeenCalled()
  })

  it('写入类能力：Redis 不可用时 fail-closed', async () => {
    const { service, capability } = build({ incrError: new Error('redis down') })
    const result = await service.precheck({ key: 'bash', capability }, caller(), { command: 'x' })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.outcome.reason).toBe('rate-limit-unavailable')
      expect(result.outcome.retryable).toBe(true)
    }
  })

  it('只读能力：Redis 不可用时保持 fail-open 降级', async () => {
    const { service, capability } = build({
      incrError: new Error('redis down'),
      capability: { risk: 'read' },
    })
    const result = await service.precheck({ key: 'file-list', capability }, caller(), {
      command: 'x',
    })
    expect(result.ok).toBe(true)
  })
})
