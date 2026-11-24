import { Injectable } from '@nestjs/common'
import { requestContext } from '@repo/kits'
import {
  AgentRuntimeClient,
  type OpenStreamResult,
  type StreamRequestOptions,
} from '@repo/internal-sdk'
import type {
  AgentChatDto,
  AgentChatResultModel,
  AgentRunSnapshotModel,
  AgentRunStopDto,
  AgentRunStopResultModel,
} from '@repo/shared'
import { agentRuntimeEndpoint } from './agent-runtime.env.js'

/**
 * main → agent-runtime 的内部调用入口（**唯一出口**）。
 *
 * 为什么单独一层：控制器只做 HTTP 边界（鉴权 / 限流 / SSE 头），内部令牌、超时、
 * 身份头（`x-user-id` / `x-admin-id` / `x-request-id`）只能有一份实现
 * —— `@repo/internal-sdk` 的 typed client（D9：app 间调用统一走 SDK，不直接 fetch 内部地址）。
 *
 * 身份头由请求上下文现算：runtime 的 `/internal/*` 用它们判定归属，main 不再让调用方传。
 */
@Injectable()
export class AgentRuntimeGateway {
  private readonly client: AgentRuntimeClient

  constructor() {
    const endpoint = agentRuntimeEndpoint()
    this.client = new AgentRuntimeClient({
      baseUrl: endpoint.baseUrl,
      token: endpoint.token,
      // 内部调用要快：控制面请求等不起 30s 的默认超时
      timeoutMs: 10_000,
    })
  }

  /** 非流式一轮问答 */
  chat(input: AgentChatDto): Promise<AgentChatResultModel> {
    return this.client.chat(input, { headers: this.identityHeaders() })
  }

  /** 停止当前轮（幂等；runId / conversationId 至少一个） */
  stopRun(input: AgentRunStopDto): Promise<AgentRunStopResultModel> {
    return this.client.stopRun(input, { headers: this.identityHeaders() })
  }

  /** 当前进行中那一轮的快照；没有则 null（上游 204） */
  snapshotCurrentRun(conversationId: string | undefined): Promise<AgentRunSnapshotModel | null> {
    return this.client.snapshotCurrentRun(conversationId, { headers: this.identityHeaders() })
  }

  /** 指定 run 的快照；没有则 null */
  snapshotRun(runId: string): Promise<AgentRunSnapshotModel | null> {
    return this.client.snapshotRun(runId, { headers: this.identityHeaders() })
  }

  /**
   * 打开执行面的流（只建连、不解析帧）。
   *
   * 额外头（`x-main-client-id` / 透传的 authorization / cookie）由控制器的 SSE 中转传入；
   * 身份头统一在这里补，避免两处 controller 各拼一份。
   */
  openStream(path: string, init: StreamRequestOptions = {}): Promise<OpenStreamResult> {
    return this.client.openStream(path, {
      ...init,
      headers: { ...this.identityHeaders(), ...init.headers },
    })
  }

  /** 当前请求的身份 + 追踪 id（无请求上下文时为空，内部调用按匿名处理） */
  private identityHeaders(): Record<string, string> {
    const headers: Record<string, string> = {}
    const userId = requestContext.get('userId')
    const adminId = requestContext.get('adminId')
    const requestId = requestContext.get('requestId')
    if (userId) headers['x-user-id'] = userId
    if (adminId) headers['x-admin-id'] = adminId
    if (requestId) headers['x-request-id'] = requestId
    return headers
  }
}
