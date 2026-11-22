import {
  AgentConversationCancelResultSchema,
  AgentInstructionsModelSchema,
  AgentListSchema,
  AgentRunQueueItemSchema,
  AgentRunQueueRemoveResultSchema,
  AgentStatusSchema,
  AgentTimelineStatusResultSchema,
  AgentToolListSchema,
  type AgentConversationCancelDto,
  type AgentConversationCancelResultModel,
  type AgentInstructionsDto,
  type AgentInstructionsModel,
  type AgentListModel,
  type AgentRunQueueItemModel,
  type AgentRunQueueRemoveDto,
  type AgentRunQueueRemoveResultModel,
  type AgentRunQueueUpdateDto,
  type AgentStatusModel,
  type AgentTimelineStatusDto,
  type AgentTimelineStatusResultModel,
  type AgentToolListModel,
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

  /** 运行时内建工具清单（控制面工具配置页用；静态声明只在 runtime 一份） */
  tools(options: InvokeOptions = {}): Promise<AgentToolListModel> {
    return requestEnvelope(this.options, '/internal/agent/tools', AgentToolListSchema, {
      method: 'POST',
      body: {},
      ...options,
    })
  }

  /**
   * 取消会话内所有进行中的 run + 队列项（main 删会话前调用）。
   *
   * runs / timelines / conversation_run_queue 的写方是 runtime；main 通过它收口，
   * 不再自己 UPDATE runs / 插 timeline。
   */
  cancelConversation(
    input: AgentConversationCancelDto,
    options: InvokeOptions = {},
  ): Promise<AgentConversationCancelResultModel> {
    return requestEnvelope(
      this.options,
      '/internal/agent/conversation/cancel',
      AgentConversationCancelResultSchema,
      {
        method: 'POST',
        body: input,
        ...options,
      },
    )
  }

  /** 追加控制面状态事件（改名 / 文件权限变更）；timeline 写方收口到 runtime */
  appendTimelineStatus(
    input: AgentTimelineStatusDto,
    options: InvokeOptions = {},
  ): Promise<AgentTimelineStatusResultModel> {
    return requestEnvelope(
      this.options,
      '/internal/agent/timeline/status',
      AgentTimelineStatusResultSchema,
      { method: 'POST', body: input, ...options },
    )
  }

  /** 修改用户排队消息（写入由 runtime 收口） */
  updateRunQueue(
    input: AgentRunQueueUpdateDto,
    options: InvokeOptions = {},
  ): Promise<AgentRunQueueItemModel> {
    return requestEnvelope(
      this.options,
      '/internal/agent/run-queue/update',
      AgentRunQueueItemSchema,
      {
        method: 'POST',
        body: input,
        ...options,
      },
    )
  }

  /** 删除用户排队消息（写入由 runtime 收口） */
  removeRunQueue(
    input: AgentRunQueueRemoveDto,
    options: InvokeOptions = {},
  ): Promise<AgentRunQueueRemoveResultModel> {
    return requestEnvelope(
      this.options,
      '/internal/agent/run-queue/remove',
      AgentRunQueueRemoveResultSchema,
      { method: 'POST', body: input, ...options },
    )
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
