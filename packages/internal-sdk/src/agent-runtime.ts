import {
  AgentChatResultSchema,
  AgentConversationCancelResultSchema,
  AgentInstructionsModelSchema,
  AgentListSchema,
  AgentRunQueueItemSchema,
  AgentRunQueueRemoveResultSchema,
  AgentRunSnapshotSchema,
  AgentRunStopResultSchema,
  AgentStatusSchema,
  AgentTimelineStatusResultSchema,
  AgentToolListSchema,
  type AgentChatDto,
  type AgentChatResultModel,
  type AgentConversationCancelDto,
  type AgentConversationCancelResultModel,
  type AgentInstructionsDto,
  type AgentInstructionsModel,
  type AgentListModel,
  type AgentRunQueueItemModel,
  type AgentRunQueueRemoveDto,
  type AgentRunQueueRemoveResultModel,
  type AgentRunQueueUpdateDto,
  type AgentRunSnapshotModel,
  type AgentRunStopDto,
  type AgentRunStopResultModel,
  type AgentStatusModel,
  type AgentTimelineStatusDto,
  type AgentTimelineStatusResultModel,
  type AgentToolListModel,
} from '@repo/shared'
import {
  openStream,
  requestEnvelope,
  requestJsonOptional,
  type InternalClientOptions,
  type InvokeOptions,
  type OpenStreamResult,
  type StreamRequestOptions,
} from './http.js'

/**
 * agent-runtime 的内部客户端（main → runtime）。
 *
 * 覆盖两类调用：
 * - **控制面查询 / 写入**：能力状态、agent 清单、内建工具、系统指令、取消会话、时间线状态、队列项；
 * - **对话执行**：非流式一轮（`chat`）、停止（`stopRun`）、运行快照（204 = 没有），
 *   以及只建立连接、不解析帧的 `openStream`（SSE 中转自己管订阅与回帧）。
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

  /** 非流式一轮问答（前端 `POST /agent/chat`；流式走 `openStream`） */
  chat(input: AgentChatDto, options: InvokeOptions = {}): Promise<AgentChatResultModel> {
    return requestEnvelope(this.options, '/internal/agent/chat', AgentChatResultSchema, {
      method: 'POST',
      body: input,
      ...options,
    })
  }

  /**
   * 停止当前轮（幂等）：`runId` 与 `conversationId` 至少给一个。
   *
   * 重复停止也返回 `{ stopped: true }`；`injected` 说明指令是本地 abort 还是经 Redis 广播。
   */
  stopRun(input: AgentRunStopDto, options: InvokeOptions = {}): Promise<AgentRunStopResultModel> {
    return requestEnvelope(this.options, '/internal/agent/run/stop', AgentRunStopResultSchema, {
      method: 'POST',
      body: input,
      ...options,
    })
  }

  /**
   * 当前进行中那一轮的快照。
   *
   * 上游用 **204** 表示"这个会话现在没在跑"：这里归一成 `null`（前端据此不点亮恢复灯）。
   * 同一接口 200 但 body 为空 / 被截断时也按 `null` 处理（2026-11-17 上游 Issue 3）。
   */
  snapshotCurrentRun(
    conversationId: string | undefined,
    options: InvokeOptions = {},
  ): Promise<AgentRunSnapshotModel | null> {
    const query = conversationId ? `?conversationId=${encodeURIComponent(conversationId)}` : ''
    return requestJsonOptional(
      this.options,
      `/internal/agent/run/snapshot${query}`,
      AgentRunSnapshotSchema,
      { method: 'GET', ...options },
    )
  }

  /** 指定 run 的快照（知道 runId 时用）；没有进行中的流时同样返回 `null` */
  snapshotRun(runId: string, options: InvokeOptions = {}): Promise<AgentRunSnapshotModel | null> {
    return requestJsonOptional(
      this.options,
      `/internal/agent/run/${encodeURIComponent(runId)}/snapshot`,
      AgentRunSnapshotSchema,
      { method: 'GET', ...options },
    )
  }

  /**
   * 打开执行面的流（SSE 透传）：只建立连接、返回原始响应体，**不解析帧**。
   *
   * main 的 `/agent/*` 中转需要：订阅先挂上、再让 runtime 开跑，内容经 pub/sub 回投；
   * 这里只把上游的 body 交给调用方持续读掉（背压），204 时 `body` 为 null。
   */
  openStream(path: string, init: StreamRequestOptions = {}): Promise<OpenStreamResult> {
    return openStream(this.options, path, init)
  }
}
