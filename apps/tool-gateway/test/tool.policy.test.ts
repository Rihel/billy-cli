import { describe, expect, it, vi } from 'vitest'
import type { AppLogger, RedisStore } from '@repo/kits'
import { TOOL_CONTRACT_VERSION, type ToolInvokeRequest } from '@repo/contracts'
import { ToolPolicyService } from '../src/policy/tool.policy.js'
import type { ToolConfigService } from '../src/config/tool.config.service.js'
import type { ToolGatewayConfigValue } from '../src/config/app-config.js'

const config = (over: Partial<ToolGatewayConfigValue> = {}): ToolGatewayConfigValue => ({
  internalToken: 'token',
  staleAfterMs: 30_000,
  invokeTimeoutMs: 30_000,
  rateLimitPerMinute: 60,
  ...over,
})

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as AppLogger

const toolConfig = {
  effective: async () => ({
    enabled: true,
    scope: null,
    allowedAgents: null,
    config: {},
    limits: {},
    secrets: {},
    version: 'test',
  }),
} as unknown as ToolConfigService

const redisOf = (used = 1) => {
  const incr = vi.fn(async () => used)
  const expire = vi.fn(async () => true)
  return { redis: { incr, expire } as unknown as RedisStore, incr, expire }
}

const request = (over: Partial<ToolInvokeRequest> = {}): ToolInvokeRequest => ({
  version: TOOL_CONTRACT_VERSION,
  requestId: 'req-1',
  toolKey: 'bash',
  toolCallId: 'call-1',
  input: { command: 'echo hi', reason: '测试' },
  caller: {
    conversationId: 'c-1',
    runId: 'r-1',
    userId: 'u-1',
    isAdmin: false,
    agentKey: 'assistant',
    rootAgentKey: 'assistant',
    depth: 0,
  },
  deadlineMs: 10_000,
  ...over,
})

describe('ToolPolicyService', () => {
  it('合法 bash：放行并摘掉 reason', async () => {
    const { redis } = redisOf()
    const policy = new ToolPolicyService(redis, toolConfig, config(), logger)
    const result = await policy.precheck(request())
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.input).toMatchObject({ command: 'echo hi' })
      expect(result.input).not.toHaveProperty('reason')
    }
  })

  it('未知工具 / 非法入参 / 超限都返回结论', async () => {
    const { redis } = redisOf()
    const policy = new ToolPolicyService(redis, toolConfig, config(), logger)
    await expect(policy.precheck(request({ toolKey: 'plan-create' }))).resolves.toMatchObject({
      ok: false,
      outcome: { reason: 'unknown-tool' },
    })
    await expect(policy.precheck(request({ input: { command: '' } }))).resolves.toMatchObject({
      ok: false,
      outcome: { reason: 'invalid-input' },
    })

    await expect(
      policy.precheck(
        request({ toolKey: 'web-fetch', input: { url: 'https://example.com', reason: '读' } }),
      ),
    ).resolves.toMatchObject({ ok: true })

    const { redis: limited } = redisOf(61)
    const limitedPolicy = new ToolPolicyService(limited, toolConfig, config(), logger)
    await expect(limitedPolicy.precheck(request())).resolves.toMatchObject({
      ok: false,
      outcome: { reason: 'rate-limited' },
    })
  })
})
