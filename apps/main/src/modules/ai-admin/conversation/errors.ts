import { AppError } from '@repo/kits'
import { AppErrorCodes } from '@repo/shared'

/**
 * 会话不存在，或不属于当前身份（**刻意不区分两者**：避免被用来探测他人会话）。
 *
 * 与新模块的服务同源：归属一律由服务端从 `requestContext` 取，前端传不了。
 */
export class ConversationNotFoundError extends AppError {
  readonly code = AppErrorCodes.ConversationNotFound
  constructor(readonly conversationId: string) {
    super(`Conversation not found: ${conversationId}`)
  }
}

/** 运行记录不存在（与「不是你的」同一口径：先查 run，再校验所属会话归属） */
export class RunNotFoundError extends AppError {
  readonly code = AppErrorCodes.RunNotFound
  constructor(readonly runId: string) {
    super(`Run not found: ${runId}`)
  }
}

/** 指定的 agent 不在静态声明里（前端传错 key / agent 已下线） */
export class AgentNotFoundError extends AppError {
  readonly code = AppErrorCodes.AgentNotFound
  constructor(readonly agentKey: string) {
    super(`Agent not found: ${agentKey}`)
  }
}
