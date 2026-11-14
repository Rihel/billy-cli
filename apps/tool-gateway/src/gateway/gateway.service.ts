import { Inject, Injectable } from '@nestjs/common'
import {
  InternalAbortError,
  InternalApiError,
  InternalProtocolError,
  InternalTimeoutError,
  InternalTransportError,
  ToolWorkerClient,
} from '@repo/internal-sdk'
import {
  TOOL_CONTRACT_VERSION,
  type ToolInvokeRequest,
  type ToolInvokeResponse,
  type ToolOutcome,
} from '@repo/contracts'
import { RedisStore } from '@repo/kits'
import { ToolGatewayConfig, type ToolGatewayConfigValue } from '../config/app-config.js'
import { WorkerDirectory } from '../workers/worker.directory.js'

/**
 * 工具网关执行体：鉴权在控制器，**策略 → 选 worker → 超时 → 审计**在这里。
 *
 * 对 worker 的调用统一走 `@repo/internal-sdk` 的 `ToolWorkerClient` —— 业务代码里不出现裸 fetch。
 * 第一版不重试：只有 `idempotent` 工具才允许重试（下一版随工具清单加）。
 */
@Injectable()
export class ToolGatewayService {
  constructor(
    @Inject(WorkerDirectory) private readonly directory: WorkerDirectory,
    @Inject(RedisStore) private readonly redis: RedisStore,
    @Inject(ToolGatewayConfig) private readonly config: ToolGatewayConfigValue,
  ) {}

  async invoke(request: ToolInvokeRequest): Promise<ToolInvokeResponse> {
    const startedAt = Date.now()

    // web-fetch / web-request 的 ref 是 worker 进程内缓存：翻页必须回到同一个 worker
    const refTool =
      request.toolKey === 'web-fetch' || request.toolKey === 'web-request' ? request.toolKey : null
    const affinityWorkerId =
      refTool && typeof request.input.ref === 'string'
        ? await this.redis
            .getJson<string>(`ai:${refTool}-ref:${request.input.ref}`)
            .catch(() => null)
        : null
    const worker =
      (affinityWorkerId
        ? await this.directory.pickById(affinityWorkerId, request.toolKey)
        : null) ?? (await this.directory.pick(request.toolKey))
    if (!worker) {
      return this.respond(request, 'none', startedAt, {
        ok: false,
        reason: 'no-worker',
        message: '没有可用的工具 worker，请稍后重试',
        retryable: true,
      })
    }

    const timeoutMs = Math.min(request.deadlineMs, this.config.invokeTimeoutMs)
    const client = new ToolWorkerClient({
      baseUrl: worker.endpoint,
      token: this.config.internalToken,
      timeoutMs,
    })

    try {
      const response = await client.exec(request, { timeoutMs })
      const ref = response.outcome.ok
        ? (response.outcome.data as { ref?: unknown } | null)?.ref
        : null
      if (refTool && typeof ref === 'string') {
        await this.redis
          .setJson(`ai:${refTool}-ref:${ref}`, response.workerId, 30 * 60)
          .catch(() => undefined)
      }
      return response
    } catch (error) {
      if (error instanceof InternalTimeoutError) {
        return this.respond(request, worker.workerId, startedAt, {
          ok: false,
          reason: 'timeout',
          message: `工具执行超时（${timeoutMs}ms）`,
          retryable: true,
        })
      }
      if (error instanceof InternalAbortError) {
        return this.respond(request, worker.workerId, startedAt, {
          ok: false,
          reason: 'aborted',
          message: '工具调用已取消',
          retryable: false,
        })
      }
      if (error instanceof InternalApiError) {
        return this.respond(request, worker.workerId, startedAt, {
          ok: false,
          reason: `worker-http-${error.status}`,
          message: `工具 worker 返回 ${error.status}${error.detail ? `：${error.detail}` : ''}`,
          retryable: error.status >= 500,
        })
      }
      if (error instanceof InternalProtocolError) {
        return this.respond(request, worker.workerId, startedAt, {
          ok: false,
          reason: 'worker-protocol-error',
          message: '工具 worker 返回了不符合契约的响应',
          retryable: false,
        })
      }
      const transport = error instanceof InternalTransportError
      return this.respond(request, worker.workerId, startedAt, {
        ok: false,
        reason: transport ? 'worker-unavailable' : 'internal',
        message: transport
          ? `无法连接工具 worker：${error.message}`
          : `工具网关内部错误：${error instanceof Error ? error.message : String(error)}`,
        retryable: transport,
      })
    }
  }

  private async respond(
    request: ToolInvokeRequest,
    workerId: string,
    startedAt: number,
    outcome: ToolOutcome,
  ): Promise<ToolInvokeResponse> {
    return {
      version: TOOL_CONTRACT_VERSION,
      requestId: request.requestId,
      workerId,
      durationMs: Date.now() - startedAt,
      outcome,
    }
  }
}
