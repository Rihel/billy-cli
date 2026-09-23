import { Inject, Injectable } from '@nestjs/common'
import type { PageQueryResult } from '@repo/kits'
import { RunNotFoundError } from '../core/ai.errors.js'
import type {
  AgentRunDetailModel,
  AgentRunIdDto,
  AgentRunListDto,
  AgentRunModel,
} from '@repo/shared'
import { AgentConversationService } from './conversation.service.js'
import { RunRepository } from './run.repository.js'

/**
 * 运行查询服务（**只读**）：审计 / 复盘页的数据源。
 *
 * 为什么单独一个服务而不是塞进 `AgentTimelineService`：时间线是"一件事一件事"，
 * 运行是"一次执行一个记录"（含子 agent 的父子关系）—— 两者是不同粒度的视角，
 * 混在一个服务里迟早会为了分页与过滤互相将就。
 *
 * **不提供任何写入 / 删除**：`runs` 是审计证据（设计文档 §4.5）。
 */
@Injectable()
export class AgentRunService {
  constructor(
    @Inject(RunRepository) private readonly runs: RunRepository,
    @Inject(AgentConversationService) private readonly conversations: AgentConversationService,
  ) {}

  /**
   * 某个会话的运行列表（**含子 agent 的 run**）。
   *
   * 返回里带 `parentRunId` / `depth` / `toolCallId`，调用方据此拼出父子树；
   * 归属校验复用会话服务（不是自己的会话 → 3304，与查看时间线同一道门）。
   */
  async list(userId: string, input: AgentRunListDto): Promise<PageQueryResult<AgentRunModel>> {
    await this.conversations.requireOwned(userId, input.conversationId)
    return this.runs.listByConversation(input.conversationId, input.page, input.size)
  }

  /**
   * 运行详情（含**输入快照**、上游错误原文与子 agent 列表）。
   *
   * 归属校验走"运行 → 会话 → 是否属于当前用户"，与其它读接口同一道门
   * （不存在与不属于自己返回同一个 3305，避免被用来探测）。
   */
  async detail(userId: string, input: AgentRunIdDto): Promise<AgentRunDetailModel> {
    const run = await this.runs.findEntity(input.runId)
    if (!run) throw new RunNotFoundError(input.runId)
    await this.conversations.requireOwned(userId, run.conversationId)

    const model: AgentRunModel = {
      id: run.id,
      conversationId: run.conversationId,
      parentRunId: run.parentRunId,
      depth: run.depth,
      toolCallId: run.toolCallId,
      agentKey: run.agentKey,
      triggeredBy: run.triggeredBy,
      requestId: run.requestId,
      status: run.status,
      recoveryCount: run.recoveryCount,
      errorCode: run.errorCode,
      errorStage: run.errorStage,
      errorMessage: run.errorMessage,
      startedAt: run.startedAt ?? undefined,
      finishedAt: run.finishedAt ?? undefined,
      durationMs: run.durationMs,
      firstTokenMs: run.firstTokenMs,
      stepCount: run.stepCount,
      toolCallCount: run.toolCallCount,
      usage: run.usage,
    }
    return {
      ...model,
      requestSnapshot: run.requestSnapshot,
      errorDetail: run.errorDetail,
      children: await this.runs.listChildren(run.id),
    }
  }
}
