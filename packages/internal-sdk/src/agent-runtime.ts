import {
  AgentInstructionsModelSchema,
  AgentListSchema,
  AgentStatusSchema,
  type AgentInstructionsDto,
  type AgentInstructionsModel,
  type AgentListModel,
  type AgentStatusModel,
} from '@repo/shared'
import { requestEnvelope, type InternalClientOptions, type InvokeOptions } from './http.js'

/**
 * agent-runtime 的内部客户端（main → runtime）。
 *
 * 只覆盖**控制面要查执行面**的三件事：能力状态、agent 清单、系统指令原文。
 * 对话执行（chat / stream / stop / resume）仍走已有的 SSE 中转，不在这个类里。
 */
export class AgentRuntimeClient {
  constructor(private readonly options: InternalClientOptions) {}

  /** 能力状态（可用模型数 + 已注册 agent 数） */
  status(options: InvokeOptions = {}): Promise<AgentStatusModel> {
    return requestEnvelope(this.options, '/internal/agent/status', AgentStatusSchema, {
      method: 'POST',
      body: {},
      ...options,
    })
  }

  /** agent 清单（`skills: ['*']` 由 runtime 按当前技能库现算） */
  list(options: InvokeOptions = {}): Promise<AgentListModel> {
    return requestEnvelope(this.options, '/internal/agent/list', AgentListSchema, {
      method: 'POST',
      body: {},
      ...options,
    })
  }

  /** 系统指令原文（静态定义；会话快照由 main 自己读时间线） */
  instructions(
    input: AgentInstructionsDto,
    options: InvokeOptions = {},
  ): Promise<AgentInstructionsModel> {
    return requestEnvelope(
      this.options,
      '/internal/agent/instructions',
      AgentInstructionsModelSchema,
      {
        method: 'POST',
        body: input,
        ...options,
      },
    )
  }
}
