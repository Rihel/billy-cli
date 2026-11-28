import type {
  AgentChatDto,
  AgentChatResumeDto,
  AgentRunSnapshotModel,
  AgentRunStopDto,
  AgentRunStopResultModel,
  AgUiEvent,
} from '@repo/shared'

/** 调用方身份：由 main 鉴权后经内部头传入，engine 不自行解析 token */
export interface EngineCaller {
  id: string
  isAdmin: boolean
}

/** 启动一轮的输入：在 HTTP DTO 之上补引擎需要的两个旁路字段 */
export interface StartRunInput extends AgentChatDto {
  /** 前端 SSE 定向频道 id（main 透传） */
  clientId?: string
  /** 端到端请求 id（审计 / 日志串联） */
  requestId?: string
}

/** 续跑挂起的一轮 */
export interface ResumeRunInput extends AgentChatResumeDto {
  clientId?: string
}

/** 停止一轮或整个会话的活跃 run */
export type StopRunInput = AgentRunStopDto

/** 快照：按 runId 或 conversationId */
export interface SnapshotInput {
  runId?: string
  conversationId?: string
}

/** 启动一轮：HTTP 入口把 body 映射成命令，engine 不直接读 Express 请求 */
export interface StartRunCommand {
  type: 'start'
  input: StartRunInput
  clientId?: string
}

/** 续跑挂起的一轮 */
export interface ResumeRunCommand {
  type: 'resume'
  input: ResumeRunInput
  clientId?: string
}

/** 停止一轮或整个会话的活跃 run */
export interface StopRunCommand {
  type: 'stop'
  input: StopRunInput
}

/** 快照：按 runId 或 conversationId */
export interface SnapshotRunCommand extends SnapshotInput {
  type: 'snapshot'
}

/** 重连：按当前 run 或指定 run 拉未读事件 */
export interface AttachRunCommand extends SnapshotInput {
  type: 'attach'
  sinceRev?: number
  clientId?: string
}

/** 引擎命令联合 */
export type EngineCommand =
  | StartRunCommand
  | ResumeRunCommand
  | StopRunCommand
  | SnapshotRunCommand
  | AttachRunCommand

/** S1 的事件就是 AG-UI 事件，wire format 不变 */
export type EngineEvent = AgUiEvent

/** 运行结束原因：Host / Recorder / 看门狗统一用它判断 */
export type RunStopReason =
  | 'done'
  | 'error'
  | 'interrupted'
  | 'suspended'
  | 'canceled'
  | 'max_steps'
  | 'cost_limit'
  | 'no_next_context'

/** 协议错误码（HTTP 映射见 `engine-errors.ts`） */
export type EngineErrorCode =
  | 'internal_unauthorized'
  | 'caller_missing'
  | 'conversation_not_found'
  | 'agent_unavailable'
  | 'model_unavailable'
  | 'conversation_busy'
  | 'run_not_resumable'
  | 'context_too_long'
  | 'model_failed'
  | 'engine_internal'

/** 统一错误响应 */
export interface EngineErrorBody {
  code: EngineErrorCode
  message: string
  runId?: string
  retryable?: boolean
}

/** RunExecutor 的返回值：快照命令直接返回模型，其余命令通过 SSE 推事件 */
export type RunSnapshotResult = AgentRunSnapshotModel | null
export type StopRunResult = AgentRunStopResultModel
