import { firstValueFrom, of } from 'rxjs'
import { describe, expect, it, vi } from 'vitest'
import type { CallHandler, ExecutionContext } from '@nestjs/common'
import type { AppLogger } from '@repo/kits'
import { TOOL_CONTRACT_VERSION, type ToolInvokeResponse } from '@repo/contracts'
import { ToolCallInterceptor } from '../src/policy/tool-call.interceptor.js'
import type { ToolAuditService } from '../src/audit/tool.audit.js'
import type { ToolPolicyService } from '../src/policy/tool.policy.js'

const request = {
  version: TOOL_CONTRACT_VERSION,
  requestId: 'req-1',
  toolKey: 'bash',
  toolCallId: 'call-1',
  input: { command: 'echo hi', reason: 'test' },
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
}

const response: ToolInvokeResponse = {
  version: TOOL_CONTRACT_VERSION,
  requestId: 'req-1',
  workerId: 'w-1',
  durationMs: 2,
  outcome: { ok: true, data: { stdout: 'hi' } },
}

const setup = (allowed: boolean) => {
  const httpRequest: { body: Record<string, unknown> } = { body: { ...request } }
  const context = {
    switchToHttp: () => ({ getRequest: () => httpRequest }),
  } as unknown as ExecutionContext
  const next = { handle: vi.fn(() => of(response)) } as unknown as CallHandler
  const audit = { record: vi.fn(async () => undefined) } as unknown as ToolAuditService
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as AppLogger
  const policy = {
    precheck: vi.fn(async () =>
      allowed
        ? {
            ok: true as const,
            input: { command: 'echo hi' },
            settings: { config: {}, limits: {}, secrets: {}, version: 'test' },
          }
        : {
            ok: false as const,
            outcome: { ok: false as const, reason: 'rate-limited', message: '太频繁' },
          },
    ),
  } as unknown as ToolPolicyService
  return {
    httpRequest,
    context,
    next,
    audit,
    logger,
    interceptor: new ToolCallInterceptor(policy, audit, logger),
  }
}

describe('ToolCallInterceptor', () => {
  it('放行时清洗入参、调用 handler 并写审计', async () => {
    const { httpRequest, context, next, audit, interceptor } = setup(true)
    const observable = await interceptor.intercept(context, next)
    const result = await firstValueFrom(observable as never)

    expect((result as ToolInvokeResponse).outcome.ok).toBe(true)
    expect(next.handle).toHaveBeenCalledOnce()
    expect(httpRequest.body.input).toEqual({ command: 'echo hi' })
    expect(httpRequest.body.settings).toMatchObject({ version: 'test' })
    expect(audit.record).toHaveBeenCalledOnce()
  })

  it('策略拒绝时短路，不调用 handler，但仍写审计', async () => {
    const { context, next, audit, interceptor } = setup(false)
    const observable = await interceptor.intercept(context, next)
    const result = await firstValueFrom(observable as never)

    expect((result as ToolInvokeResponse).outcome).toMatchObject({
      ok: false,
      reason: 'rate-limited',
    })
    expect(next.handle).not.toHaveBeenCalled()
    expect(audit.record).toHaveBeenCalledOnce()
  })
})
