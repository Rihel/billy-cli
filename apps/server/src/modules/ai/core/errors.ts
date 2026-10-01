import { AppErrorCodes } from '@repo/shared'
import { AppError } from '@repo/kits'

/** AI 能力未配置（缺 `MASTRA_MODEL` / `MASTRA_API_KEY`）：不是故障，是「没开」 */
export class AgentUnavailableError extends AppError {
  readonly code = AppErrorCodes.AgentUnavailable
  constructor() {
    super('AI 能力未配置：请设置 MASTRA_MODEL 与 MASTRA_API_KEY')
  }
}

/** 指定的 agent 不在注册表里（前端传错 key / agent 已下线） */
export class AgentNotFoundError extends AppError {
  readonly code = AppErrorCodes.AgentNotFound
  constructor(readonly agentKey: string) {
    super(`Agent not found: ${agentKey}`)
  }
}

/** 模型调用 / 流式转换失败（上游错误、网络、鉴权失败等） */
export class AgentFailedError extends AppError {
  readonly code = AppErrorCodes.AgentFailed
  constructor(readonly reason: string) {
    super(`AI 回复失败: ${reason}`)
  }
}

/** 会话不存在，或不属于当前用户（**刻意不区分两者**：避免被用来探测他人会话） */
export class ConversationNotFoundError extends AppError {
  readonly code = AppErrorCodes.ConversationNotFound
  constructor(readonly conversationId: string) {
    super(`Conversation not found: ${conversationId}`)
  }
}

/** 运行记录不存在 */
export class RunNotFoundError extends AppError {
  readonly code = AppErrorCodes.RunNotFound
  constructor(readonly runId: string) {
    super(`Run not found: ${runId}`)
  }
}

/** 该会话已有进行中的一轮（并发拒绝；底层由 runs 的部分唯一索引兜住） */
export class ConversationBusyError extends AppError {
  readonly code = AppErrorCodes.ConversationBusy
  constructor(readonly conversationId: string) {
    super(`Conversation is busy: ${conversationId}`)
  }
}

/** 上下文超出模型窗口且无法再压缩（不硬塞：硬塞会被上游 400） */
export class ContextTooLongError extends AppError {
  readonly code = AppErrorCodes.ContextTooLong
  constructor(readonly estimatedTokens: number) {
    super(`Context too long: ${estimatedTokens}`)
  }
}

/** 模型鉴权失败（部署配置问题；要能一眼看出不是用户的问题） */
export class ProviderAuthFailedError extends AppError {
  readonly code = AppErrorCodes.ProviderAuthFailed
  constructor(readonly reason: string) {
    super(`模型鉴权失败: ${reason}`)
  }
}

/** 上游模型限流（区别于我们自己的限流 4002） */
export class ProviderRateLimitedError extends AppError {
  readonly code = AppErrorCodes.ProviderRateLimited
  constructor(readonly reason: string) {
    super(`模型服务繁忙: ${reason}`)
  }
}
