import { randomUUID } from 'node:crypto'
import { Inject, Injectable } from '@nestjs/common'
import { AppLogger, Db } from '@repo/kits'
import { AiToolAuditEntity } from '@repo/db'
import type { ToolOutcome } from '@repo/contracts'

/** 一次工具调用的审计记录（gateway 是唯一写方；facade 只写 timeline） */
@Injectable()
export class ToolAuditService {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}

  async record(input: {
    requestId: string
    runId: string
    conversationId: string
    userId: string | null
    toolKey: string
    toolCallId: string | null
    workerId: string
    outcome: ToolOutcome
    durationMs: number
  }): Promise<void> {
    const status = input.outcome.ok
      ? 'ok'
      : input.outcome.reason === 'forbidden' || input.outcome.reason === 'invalid-input'
        ? 'denied'
        : 'error'
    try {
      const repo = this.db.getRepository(AiToolAuditEntity)
      await repo.save(
        repo.create({
          id: randomUUID(),
          requestId: input.requestId,
          runId: input.runId,
          conversationId: input.conversationId,
          userId: input.userId,
          toolKey: input.toolKey,
          toolCallId: input.toolCallId,
          workerId: input.workerId,
          status,
          reason: input.outcome.ok ? null : input.outcome.reason,
          durationMs: input.durationMs,
        }),
      )
    } catch (error) {
      // 审计写失败不阻断工具结论，但要留痕
      this.logger.error('tool_gateway.audit_failed', {
        requestId: input.requestId,
        reason: error instanceof Error ? error.message : String(error),
      })
    }
  }
}
