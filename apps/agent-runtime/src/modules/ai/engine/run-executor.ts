import { Inject, Injectable } from '@nestjs/common'
import type {
  AgentChatResultModel,
  AgentRunSnapshotModel,
  AgentRunStopResultModel,
} from '@repo/shared'
import { AgentChatService, type StreamResponseLike } from '../runtime/chat.service.js'
import type {
  AttachRunCommand,
  EngineCaller,
  ResumeRunCommand,
  SnapshotRunCommand,
  StartRunCommand,
  StopRunCommand,
} from './protocol.js'

/**
 * Engine 的执行入口。
 *
 * S1 的第一刀是**适配层**：现有 `AgentChatService` 仍承担具体执行，controller 只和
 * `RunExecutor` 打交道。后续把 `chat.service` 的编排逐步搬进来时，Host 与协议不变。
 */
@Injectable()
export class RunExecutor {
  constructor(@Inject(AgentChatService) private readonly chat: AgentChatService) {}

  /** 非流式一轮 */
  startOnce(caller: EngineCaller, command: StartRunCommand): Promise<AgentChatResultModel> {
    return this.chat.chat(caller.id, command.input, caller.isAdmin)
  }

  /** 流式一轮：SSE 由 controller 负责，executor 只做命令映射 */
  startStream(
    caller: EngineCaller,
    command: StartRunCommand,
    response: StreamResponseLike,
  ): Promise<void> {
    return this.chat.chatStream(
      caller.id,
      command.input,
      response,
      caller.isAdmin,
      command.clientId,
    )
  }

  /** 续跑挂起的一轮 */
  resumeStream(
    caller: EngineCaller,
    command: ResumeRunCommand,
    response: StreamResponseLike,
  ): Promise<void> {
    return this.chat.resumeChat(
      caller.id,
      command.input,
      response,
      caller.isAdmin,
      command.clientId,
    )
  }

  /** 停止当前轮 / 指定 run（幂等） */
  stop(caller: EngineCaller, command: StopRunCommand): Promise<AgentRunStopResultModel> {
    return this.chat.stopRun(caller.id, command.input)
  }

  /** 快照：按 runId 或 conversationId */
  snapshot(
    caller: EngineCaller,
    command: SnapshotRunCommand,
  ): Promise<AgentRunSnapshotModel | null> {
    if (command.runId) return this.chat.snapshotRun(caller.id, command.runId)
    return this.chat.snapshotCurrentRun(caller.id, command.conversationId)
  }

  /** 重连：没有可续的流返回 false（controller 回 204） */
  attach(
    caller: EngineCaller,
    command: AttachRunCommand,
    response: StreamResponseLike,
  ): Promise<boolean> {
    if (command.runId) {
      return this.chat.resumeRun(
        caller.id,
        command.runId,
        command.sinceRev,
        response,
        command.clientId,
      )
    }
    return this.chat.resumeCurrentRun(
      caller.id,
      command.sinceRev,
      response,
      command.conversationId,
      command.clientId,
    )
  }
}
