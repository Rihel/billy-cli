import { Inject, Injectable } from '@nestjs/common'
import { AppLogger } from '@repo/kits'
import type { ToolInvokeRequest, ToolOutcome } from '@repo/contracts'
import { ToolExecutorRegistry } from './executors/executor.registry.js'

/**
 * worker 执行编排：只按 toolKey 找执行器，不关心具体工具。
 *
 * 授权 / 限流 / 审计在 gateway；执行器自己负责入参校验与隔离执行。
 * 未注册的工具返回 `unsupported-tool`（而不是抛异常），gateway 会把它当结论回给模型。
 */
@Injectable()
export class ToolWorkerService {
  constructor(
    @Inject(ToolExecutorRegistry) private readonly executors: ToolExecutorRegistry,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}

  async execute(request: ToolInvokeRequest): Promise<ToolOutcome> {
    const executor = this.executors.get(request.toolKey)
    if (!executor) {
      return {
        ok: false,
        reason: 'unsupported-tool',
        message: `本 worker 不支持工具：${request.toolKey}`,
        retryable: false,
      }
    }
    const startedAt = Date.now()
    try {
      const outcome = await executor.execute(request)
      this.logger.info('tool_worker.executed', {
        requestId: request.requestId,
        runId: request.caller.runId,
        conversationId: request.caller.conversationId,
        toolKey: request.toolKey,
        ok: outcome.ok,
        ...(outcome.ok ? {} : { reason: outcome.reason }),
        durationMs: Date.now() - startedAt,
      })
      return outcome
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      this.logger.error('tool_worker.exec_failed', {
        requestId: request.requestId,
        runId: request.caller.runId,
        toolKey: request.toolKey,
        reason,
      })
      return {
        ok: false,
        reason: 'exec-failed',
        message: `工具执行失败：${reason}`,
        retryable: true,
      }
    }
  }
}
