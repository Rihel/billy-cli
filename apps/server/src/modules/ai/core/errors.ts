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

/** 这一轮没有挂起（已结束 / 被取消 / 状态不对），不能 resume */
export class RunNotSuspendedError extends AppError {
  readonly code = AppErrorCodes.RunNotSuspended
  constructor(readonly runId: string) {
    super(`Run is not suspended: ${runId}`)
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

/**
 * 附件取不回来（对象不存在 / 存储不可用）。
 *
 * 为什么不静默跳过这条附件：用户发出去的东西在他眼里"已经发出去了"，模型却看不到 ——
 * 那会得到一段**对看不见的附件胡说**的回复，比直接报错坏得多。
 */
export class ChatAttachmentFailedError extends AppError {
  readonly code = AppErrorCodes.ChatAttachmentFailed
  constructor(readonly filename: string) {
    super(`附件读取失败: ${filename}`)
  }
}

/**
 * 这一轮的附件超出了当前模型能收的范围（不支持图片 / 不支持文件）。
 *
 * 为什么要在**我们这边**拦：给一个收不了图的模型发图，最坏的结果是上游**静默忽略** ——
 * 用户以为模型看过了图，其实它什么也没看到，接着基于幻觉回答。宁可当场说清楚。
 */
export class ModelCapabilityMismatchError extends AppError {
  readonly code = AppErrorCodes.ModelCapabilityMismatch
  constructor(
    readonly filename: string,
    readonly reason: string,
  ) {
    super(`${reason}：${filename}`)
  }
}

/**
 * 模型**长时间一个字都没吐**（首 token 超时）。
 *
 * 为什么要单独成码而不是等看门狗判 3310：10 分钟的总时长上限是为"真的长"准备的，
 * 而"一个字都没有"说明上游已经卡住 —— 继续等只会让用户干看着，还占着会话（3306）。
 * 这个错误在**建流之后**抛出，走 SSE 收尾；前端能立刻显示"换个模型 / 重试"。
 */
export class ModelNoResponseError extends AppError {
  readonly code = AppErrorCodes.ModelNoResponse
  constructor(readonly timeoutMs: number) {
    super(`模型长时间没有响应（超过 ${Math.round(timeoutMs / 1000)} 秒没有输出）`)
  }
}

/**
 * 上下文组装出来的最后一条不是用户消息（内部不变量被破坏）。
 *
 * 正常情况下 `ContextService` 一定把当前输入放在最后 —— 一旦不成立，附件就会**静默丢掉**。
 * 宁可当场报错：这类"今天正好成立"的隐式依赖，出事时表现为"模型看不见我发的图"，
 * 从现象往回查要绕很久。
 */
export class UserContentNotAppendableError extends AppError {
  readonly code = AppErrorCodes.ModelCapabilityMismatch
  constructor(readonly messageCount: number) {
    super(`上下文末条不是用户消息（共 ${messageCount} 条），附件无法注入`)
  }
}
