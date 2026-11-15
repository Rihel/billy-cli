import { firstValueFrom, of, type Observable } from 'rxjs'
import { describe, expect, it, vi } from 'vitest'
import type { CallHandler, ExecutionContext, Type } from '@nestjs/common'
import { TOOL_CONTRACT_VERSION, type ToolInvokeResponse } from '@repo/contracts'
import type { AppLogger } from '@repo/kits'
import { ResponseEnvelopeInterceptor } from '@repo/kits'
import { ToolGatewayController } from '../src/gateway/gateway.controller.js'
import { ToolCallInterceptor } from '../src/policy/tool-call.interceptor.js'
import type { ToolAuditService } from '../src/audit/tool.audit.js'
import type { ToolPolicyService } from '../src/policy/tool.policy.js'

/**
 * 「信封 × 审计」组合的回归测试。
 *
 * 背景：`@UseInterceptors(ToolCallInterceptor, ResponseEnvelopeInterceptor)` 时，信封在**内层**，
 * 它先把返回包成 `{ code, data }` 再交给审计的 `tap`，审计读 `response.outcome` 得到 undefined →
 * TypeError → 整条工具调用 500。2026-11-15 实测：所有经网关的工具调用都回 `5001`，
 * 而 worker 其实已经执行成功，模型只能判定「网络全挂」。
 */

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

const rawResponse: ToolInvokeResponse = {
  version: TOOL_CONTRACT_VERSION,
  requestId: 'req-1',
  workerId: 'w-1',
  durationMs: 2,
  outcome: { ok: true, data: { stdout: 'hi' } },
}

const setup = () => {
  const httpRequest: { body: Record<string, unknown> } = { body: { ...request } }
  const context = {
    switchToHttp: () => ({ getRequest: () => httpRequest }),
  } as unknown as ExecutionContext
  const audit = { record: vi.fn(async () => undefined) } as unknown as ToolAuditService
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as AppLogger
  const policy = {
    precheck: vi.fn(async () => ({
      ok: true as const,
      input: { command: 'echo hi' },
      settings: { config: {}, limits: {}, secrets: {}, version: 'test' },
    })),
  } as unknown as ToolPolicyService
  return {
    context,
    audit,
    logger,
    envelope: new ResponseEnvelopeInterceptor(),
    interceptor: new ToolCallInterceptor(policy, audit, logger),
  }
}

describe('invoke 路由的信封与审计顺序', () => {
  it('控制器按「信封在外、审计在内」绑定拦截器', () => {
    const bound = Reflect.getMetadata(
      '__interceptors__',
      ToolGatewayController.prototype.invoke,
    ) as Type<unknown>[] | undefined

    expect(bound).toBeDefined()
    expect(bound).toEqual([ResponseEnvelopeInterceptor, ToolCallInterceptor])
  })

  it('放行时返回信封，且审计读到的是裸业务体（不炸 500）', async () => {
    const { context, audit, envelope, interceptor } = setup()
    // 复刻 Nest 的组合方式：数组里靠前的是外层
    const inner = (await interceptor.intercept(context, {
      handle: () => of(rawResponse),
    } as CallHandler)) as Observable<unknown>
    const observable = envelope.intercept(context, {
      handle: () => inner,
    }) as Observable<unknown>

    const result = await firstValueFrom(observable)

    expect(result).toMatchObject({
      code: 0,
      data: { requestId: 'req-1', outcome: { ok: true, data: { stdout: 'hi' } } },
    })
    expect(audit.record).toHaveBeenCalledOnce()
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: { ok: true, data: { stdout: 'hi' } } }),
    )
  })

  it('顺序被写反时也不炸：审计能拆信封，工具结论照常返回', async () => {
    const { context, audit, envelope, interceptor } = setup()
    const inner = envelope.intercept(context, {
      handle: () => of(rawResponse),
    } as CallHandler) as Observable<unknown>
    const observable = (await interceptor.intercept(context, {
      handle: () => inner,
    } as CallHandler)) as Observable<ToolInvokeResponse>

    const result = await firstValueFrom(observable)

    // 写反顺序时客户端拿到的是外层的信封（runtime 仍能解），关键是**不抛错**
    const enveloped = result as unknown as { code: number; data: ToolInvokeResponse }
    expect(enveloped.code).toBe(0)
    expect(enveloped.data.outcome).toEqual({ ok: true, data: { stdout: 'hi' } })
    // 兜底：拆信封后仍能审计成功（而不是像修复前那样 read undefined → TypeError → 500）
    expect(audit.record).toHaveBeenCalledOnce()
  })
})
