import { Inject, Injectable } from '@nestjs/common'
import { AppLogger } from '@repo/kits'
import type { ApprovalPort, ApprovalRequest } from '../ports.js'

/**
 * 审批接缝 S1 实现：只接 `ask-user-questions` 的「挂起 → 用户回答后续跑」两跳。
 *
 * 挂起的**状态**由执行体写 `runs.status=suspended`（会话被占用、快照保留），
 * 这里只补审计事实：哪一轮在等什么、用户最终答了几个问题 / 是否取消。
 * 将来接「危险命令人工批准」时，替换本适配器即可，执行体只认 `ApprovalPort`。
 */
@Injectable()
export class AskUserQuestionsApprovalPort implements ApprovalPort {
  constructor(@Inject(AppLogger) private readonly logger: AppLogger) {}

  async suspend(input: ApprovalRequest): Promise<void> {
    this.logger.log('engine.approval.suspend', {
      runId: input.runId,
      conversationId: input.conversationId,
      ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
      questionCount: input.questions.length,
    })
  }

  async resume(input: { runId: string; cancelled: boolean; answerCount: number }): Promise<void> {
    this.logger.log('engine.approval.resume', {
      runId: input.runId,
      cancelled: input.cancelled,
      answerCount: input.answerCount,
    })
  }
}
