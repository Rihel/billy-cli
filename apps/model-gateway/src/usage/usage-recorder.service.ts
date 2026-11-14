import { Inject, Injectable } from '@nestjs/common'
import type { GatewayUsage } from '@repo/contracts'
import { ModelGatewayUsageEntity } from '@repo/db'
import { AppLogger, Db } from '@repo/kits'
import { nanoid } from '@repo/shared'
import type { GatewayTarget } from '../catalog/model.catalog.service.js'
import { costMicrosOf } from './usage.js'

export interface UsageAttribution {
  runId?: string | null
  conversationId?: string | null
  identityType?: string | null
  identityId?: string | null
}

export interface UsageRecordInput {
  requestId: string
  attempt?: number
  target: GatewayTarget
  keyId?: string | null
  stream: boolean
  status: 'success' | 'error' | 'aborted' | 'rejected'
  httpStatus?: number | null
  usage: GatewayUsage | null
  ttftMs?: number | null
  durationMs?: number | null
  attribution?: UsageAttribution
}

/**
 * 逐请求用量流水（`model_gateway_usage`）。
 *
 * 写失败只记日志、不影响模型响应（计量不能把主链路拖死）。
 */
@Injectable()
export class UsageRecorder {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}

  async record(input: UsageRecordInput): Promise<number | null> {
    try {
      const { costMicros, priceSnapshot } = costMicrosOf(input.usage, input.target.prices)
      const repo = this.db.getRepository(ModelGatewayUsageEntity)
      await repo.save(
        repo.create({
          id: nanoid(),
          requestId: input.requestId,
          attempt: input.attempt ?? 1,
          runId: input.attribution?.runId ?? null,
          conversationId: input.attribution?.conversationId ?? null,
          identityType: input.attribution?.identityType ?? null,
          identityId: input.attribution?.identityId ?? null,
          providerId: input.target.entry.providerId,
          modelId: input.target.entry.id,
          keyId: input.keyId ?? null,
          stream: input.stream,
          status: input.status,
          httpStatus: input.httpStatus ?? null,
          errorCode: null,
          unitType: 'token',
          inputTokens: input.usage?.inputTokens ?? null,
          outputTokens: input.usage?.outputTokens ?? null,
          totalTokens: input.usage?.totalTokens ?? null,
          cacheReadTokens: input.usage?.cacheReadTokens ?? null,
          cacheWriteTokens: input.usage?.cacheWriteTokens ?? null,
          reasoningTokens: input.usage?.reasoningTokens ?? null,
          units: null,
          costMicros,
          priceSnapshot: priceSnapshot as Record<string, unknown> | null,
          ttftMs: input.ttftMs ?? null,
          durationMs: input.durationMs ?? null,
          usageMissing: input.usage === null,
        }),
      )
      return costMicros
    } catch (error) {
      this.logger.warn('model.gateway.usage_write_failed', { error })
      return null
    }
  }
}
