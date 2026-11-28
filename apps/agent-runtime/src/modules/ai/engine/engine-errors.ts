import { AppError } from '@repo/kits'
import { AppErrorCodes } from '@repo/shared'
import type { EngineErrorBody, EngineErrorCode } from './protocol.js'

/** 引擎内部错误：携带协议码与 HTTP 状态，Host 适配层据此回统一错误体 */
export class EngineError extends Error {
  constructor(
    readonly code: EngineErrorCode,
    message: string,
    readonly http: number,
    readonly retryable = false,
    readonly runId?: string,
  ) {
    super(message)
    this.name = 'EngineError'
  }

  toBody(): EngineErrorBody {
    return {
      code: this.code,
      message: this.message,
      ...(this.runId ? { runId: this.runId } : {}),
      ...(this.retryable ? { retryable: true } : {}),
    }
  }
}

/** 协议码 → HTTP 状态（业务错误码优先沿用 `AppErrorCodes` 的 http，wire format 不变） */
const HTTP_BY_CODE: Record<EngineErrorCode, number> = {
  internal_unauthorized: 401,
  caller_missing: 401,
  conversation_not_found: 404,
  agent_unavailable: 503,
  model_unavailable: 400,
  conversation_busy: 409,
  run_not_resumable: 409,
  context_too_long: 400,
  model_failed: 502,
  engine_internal: 500,
}

/** `AppErrorCodes` 的业务码 → 引擎协议码 */
const CODE_BY_APP_ERROR: Record<number, EngineErrorCode> = {
  [AppErrorCodes.ConversationNotFound]: 'conversation_not_found',
  [AppErrorCodes.RunNotFound]: 'conversation_not_found',
  [AppErrorCodes.AgentUnavailable]: 'agent_unavailable',
  [AppErrorCodes.AgentNotFound]: 'agent_unavailable',
  [AppErrorCodes.AgentFailed]: 'model_failed',
  [AppErrorCodes.ConversationBusy]: 'conversation_busy',
  [AppErrorCodes.ContextTooLong]: 'context_too_long',
  [AppErrorCodes.RunNotSuspended]: 'run_not_resumable',
  [AppErrorCodes.ProviderAuthFailed]: 'model_failed',
  [AppErrorCodes.ProviderRateLimited]: 'model_failed',
  [AppErrorCodes.ModelNoResponse]: 'model_failed',
  [AppErrorCodes.RunTimeout]: 'model_failed',
  [AppErrorCodes.ChatAttachmentFailed]: 'engine_internal',
  [AppErrorCodes.ModelCapabilityMismatch]: 'model_unavailable',
}

/** 可重试的失败（上游抖动 / 超时，而不是配置或入参错误） */
const RETRYABLE_APP_ERRORS = new Set<number>([
  AppErrorCodes.AgentFailed,
  AppErrorCodes.ProviderRateLimited,
  AppErrorCodes.ModelNoResponse,
  AppErrorCodes.RunTimeout,
])

/**
 * 任意错误 → 引擎错误。
 *
 * 不吞业务码：`AppError` 的 code 已经表达「模型禁用 / 未配模型 / 附件不可读」等
 * 可行动原因，映射只是把它翻译成协议码，message 原样保留。
 */
export const toEngineError = (error: unknown): EngineError => {
  if (error instanceof EngineError) return error
  if (error instanceof AppError) {
    const code =
      (CODE_BY_APP_ERROR as Record<number, EngineErrorCode>)[error.code] ?? 'engine_internal'
    return new EngineError(
      code,
      error.message,
      HTTP_BY_CODE[code],
      RETRYABLE_APP_ERRORS.has(error.code),
    )
  }
  const message = error instanceof Error ? error.message : String(error)
  return new EngineError('engine_internal', message, HTTP_BY_CODE.engine_internal)
}

/** 构造一个协议错误（controller 的鉴权分支用） */
export const engineError = (
  code: EngineErrorCode,
  message: string,
  options: { runId?: string; retryable?: boolean } = {},
): EngineError =>
  new EngineError(code, message, HTTP_BY_CODE[code], options.retryable === true, options.runId)
