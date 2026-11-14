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
      return next
        .handle()
        .pipe(tap((response: ToolInvokeResponse) => this.record(raw, response, startedAt)))
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
    response: ToolInvokeResponse,
    startedAt: number,
  ): void {
    if (!raw?.requestId || !raw.toolKey || !raw.caller) return
    const durationMs = Date.now() - startedAt
    this.logger.info('tool_gateway.invoked', {
      requestId: response.requestId,
      runId: raw.caller.runId,
      conversationId: raw.caller.conversationId,
      toolKey: raw.toolKey,
      toolCallId: raw.toolCallId ?? null,
      workerId: response.workerId,
      ok: response.outcome.ok,
      ...(response.outcome.ok ? {} : { reason: response.outcome.reason }),
      durationMs,
    })
    void this.audit.record({
      requestId: response.requestId,
      runId: raw.caller.runId,
      conversationId: raw.caller.conversationId,
      userId: raw.caller.userId ?? null,
      toolKey: raw.toolKey,
      toolCallId: raw.toolCallId ?? null,
      workerId: response.workerId,
      outcome: response.outcome,
      durationMs,
    })
  }
}
