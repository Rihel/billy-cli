import { Inject, Injectable } from '@nestjs/common'
import { AppLogger } from '@repo/kits'
import type { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common'
import { of, tap } from 'rxjs'
import {
  TOOL_CONTRACT_VERSION,
  ToolInvokeRequestSchema,
  type ToolInvokeRequest,
  type ToolInvokeResponse,
  type ToolOutcome,
} from '@repo/contracts'
import { ToolAuditService } from '../audit/tool.audit.js'
import { ToolPolicyService } from './tool.policy.js'

interface HttpRequestLike {
  body?: unknown
}

/**
 * 取审计要读的业务体（兼容「已包信封」与「裸响应」两种形态）。
 *
 * `ResponseEnvelopeInterceptor` 是控制器上更外层的那一个时，它会先把 handler 的返回值包成
 * `{ code, data }` 再交给本拦截器的 `tap` —— 此时 `response.outcome` 是 `undefined`，
 * 直接读就把整条工具调用炸成 500（2026-11-15 实测：所有工具调用回 `5001`，
 * 而 worker 其实已经执行成功，只是结论被吞掉，模型只能判定「网络全挂」）。
 *
 * 审计是旁路：拆不出业务体就少写一条并告警，绝不能反过来毁掉工具结论。
 */
const businessBodyOf = (value: unknown): ToolInvokeResponse | null => {
  if (!value || typeof value !== 'object') return null
  const candidate = 'outcome' in value ? value : (value as { data?: unknown }).data
  return candidate && typeof candidate === 'object' && 'outcome' in candidate
    ? (candidate as ToolInvokeResponse)
    : null
}

/**
 * 工具调用切面（Nest Interceptor）：**策略 pre → handler → 审计 post**。
 *
 * 为什么用 Interceptor 而不是 Controller 里手写：
 * - pre 可以短路（策略拒绝时不进入 handler），post 统一落审计；
 * - 拒绝 / 成功 / worker 失败都是同一个 `ToolInvokeResponse`，审计只做一次；
 * - 校验仍由 Pipe 做（契约），鉴权由 Guard 做（令牌），各归各的 Nest 生命周期。
 *
 * 注意：Nest 的 interceptor 在 pipe 之前执行，所以这里读到的是原始 body；
 * 策略校验通过后把清洗后的 input 写回 body，后面的 Pipe 仍然会按契约再校验一次。
 */
@Injectable()
export class ToolCallInterceptor implements NestInterceptor {
  constructor(
    @Inject(ToolPolicyService) private readonly policy: ToolPolicyService,
    @Inject(ToolAuditService) private readonly audit: ToolAuditService,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler) {
    const startedAt = Date.now()
    const request = context.switchToHttp().getRequest<HttpRequestLike>()
    const raw = request.body as Partial<ToolInvokeRequest> | undefined
    const parsed = ToolInvokeRequestSchema.safeParse(request.body)
    if (!parsed.success) {
      const response = this.response(raw, 'none', startedAt, {
        ok: false,
        reason: 'invalid-input',
        message: `工具调用请求不合法：${parsed.error.issues[0]?.message ?? '未知错误'}`,
        retryable: false,
      })
      this.record(raw, response, startedAt)
      return of(response)
    }
    const invokeRequest = parsed.data

    return this.policy.precheck(invokeRequest).then((checked) => {
      if (!checked.ok) {
        const response = this.response(raw, 'none', startedAt, checked.outcome)
        this.record(raw, response, startedAt)
        return of(response)
      }
      // 清洗后的入参交给后面的 Pipe / handler；reason 不再下传
      request.body = { ...invokeRequest, input: checked.input, settings: checked.settings }
      return next.handle().pipe(tap((response: unknown) => this.record(raw, response, startedAt)))
    }) as ReturnType<NestInterceptor['intercept']>
  }

  private response(
    raw: Partial<ToolInvokeRequest> | undefined,
    workerId: string,
    startedAt: number,
    outcome: ToolOutcome,
  ): ToolInvokeResponse {
    return {
      version: TOOL_CONTRACT_VERSION,
      requestId: typeof raw?.requestId === 'string' ? raw.requestId : 'invalid',
      workerId,
      durationMs: Date.now() - startedAt,
      outcome,
    }
  }

  private record(
    raw: Partial<ToolInvokeRequest> | undefined,
    response: unknown,
    startedAt: number,
  ): void {
    if (!raw?.requestId || !raw.toolKey || !raw.caller) return
    const body = businessBodyOf(response)
    if (!body) {
      this.logger.warn('tool_gateway.audit_skipped', {
        requestId: raw.requestId,
        toolKey: raw.toolKey,
        reason: '响应里没有 outcome，审计跳过',
      })
      return
    }
    const durationMs = Date.now() - startedAt
    this.logger.info('tool_gateway.invoked', {
      requestId: body.requestId,
      runId: raw.caller.runId,
      conversationId: raw.caller.conversationId,
      toolKey: raw.toolKey,
      toolCallId: raw.toolCallId ?? null,
      workerId: body.workerId,
      ok: body.outcome.ok,
      ...(body.outcome.ok ? {} : { reason: body.outcome.reason }),
      durationMs,
    })
    void this.audit.record({
      requestId: body.requestId,
      runId: raw.caller.runId,
      conversationId: raw.caller.conversationId,
      userId: raw.caller.userId ?? null,
      toolKey: raw.toolKey,
      toolCallId: raw.toolCallId ?? null,
      workerId: body.workerId,
      outcome: body.outcome,
      durationMs,
    })
  }
}
