import { Inject, Injectable } from '@nestjs/common'
import { AppLogger, StreamHub } from '@repo/kits'
import {
  STREAM_AI_OWNER_CHANNEL_PREFIX,
  STREAM_CONVERSATION_RUN_CHANGED_EVENT,
  STREAM_CONVERSATION_RUN_STARTED_EVENT,
  STREAM_CONVERSATION_TITLE_CHANGED_EVENT,
  type ConversationRunChangedEventModel,
  type ConversationRunStartedEventModel,
  type ConversationTitleChangedEventModel,
} from '@repo/shared'
import { ConversationRepository } from '../conversation/conversation.repository.js'

/**
 * 运行态变更通知（旁路能力）：把「某个会话现在还有没有在跑的一轮」推给它的归属者。
 *
 * 为什么需要它：侧栏的「运行中」呼吸灯原来靠**条件轮询**（缓存里有 running 才每 5s 拉一次列表）——
 * 轮询要解决的正是"服务端状态变了、前端无从得知"，而这本来就是事件该负责的事。
 *
 * 为什么 `running` 在**发布时现算**、而不是由状态机推断：真相在 `runs`（根 run 的
 * pending / running），写这个状态的分支很多（正常收尾 / 挂起 / 停止 / 看门狗判超时 /
 * 重启恢复 / 删会话前取消），任何一处判错都会让界面永久停在错误状态。多一次索引查询，
 * 换来"推下去的永远是库里的事实"。
 *
 * 旁路约束：推流失败只记 warn，绝不影响运行主流程（与告警推流同一姿态）。
 */
export interface RunStatusListener {
  /** 某个会话的运行态可能变了：查一次真相并推给归属者 */
  changed(conversationId: string): Promise<void>
}

/** `RunStatusListener` 的注入 token（仓储只依赖接口，测试可传替身） */
export const RUN_STATUS_LISTENER = Symbol.for('RunStatusListener')

@Injectable()
export class RunStatusStream implements RunStatusListener {
  constructor(
    @Inject(StreamHub) private readonly hub: StreamHub,
    @Inject(ConversationRepository) private readonly conversations: ConversationRepository,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}

  /**
   * 新开一轮：告诉归属者"这一轮是谁发起的（user / subagent 唤醒）"。
   *
   * 排队消息与子 agent 唤醒都在**没有前端连接**的情况下起跑；页面靠这条事件知道
   * 该把流接回哪个会话（`running=true` 的 changed 事件只说明在跑，不说明接哪一轮）。
   * 失败只 warn，不影响运行主流程。
   */
  async started(conversationId: string, runId: string, origin: string): Promise<void> {
    try {
      const ownerId = await this.conversations.findOwnerId(conversationId)
      if (!ownerId) return
      const payload: ConversationRunStartedEventModel = { conversationId, runId, origin }
      this.hub.publish(`${STREAM_AI_OWNER_CHANNEL_PREFIX}${ownerId}`, {
        event: STREAM_CONVERSATION_RUN_STARTED_EVENT,
        data: payload,
      })
    } catch (error) {
      this.logger.warn('ai.run_status.started_failed', {
        conversationId,
        runId,
        reason: error instanceof Error ? error.message : String(error),
      })
    }
  }

  /**
   * 会话**标题变了**：推给归属者，前端侧栏 / 页头当场更新。
   *
   * 与 `data-conversation-title`（run 流内的数据事件）的分工：首轮命名现在与主回答**并行**跑，
   * 名字可能在回答收尾之前就出来，从一条有序的 run 流中间插数据事件会打乱 rev 顺序；
   * 而整站 SSE 是独立频道，且**非流式入口**（`/agent/chat`）没有 run 流，只有这条通路推得出去。
   * 失败只 warn，不影响运行主流程（与另外两条通知同一姿态）。
   */
  async titleChanged(conversationId: string, title: string): Promise<void> {
    try {
      const ownerId = await this.conversations.findOwnerId(conversationId)
      if (!ownerId) return
      const payload: ConversationTitleChangedEventModel = { conversationId, title }
      this.hub.publish(`${STREAM_AI_OWNER_CHANNEL_PREFIX}${ownerId}`, {
        event: STREAM_CONVERSATION_TITLE_CHANGED_EVENT,
        data: payload,
      })
    } catch (error) {
      this.logger.warn('ai.conversation.title_push_failed', {
        conversationId,
        title,
        reason: error instanceof Error ? error.message : String(error),
      })
    }
  }

  async changed(conversationId: string): Promise<void> {
    try {
      const ownerId = await this.conversations.findOwnerId(conversationId)
      if (!ownerId) return
      const running = await this.conversations.isRunning(conversationId)
      const payload: ConversationRunChangedEventModel = { conversationId, running }
      this.hub.publish(`${STREAM_AI_OWNER_CHANNEL_PREFIX}${ownerId}`, {
        event: STREAM_CONVERSATION_RUN_CHANGED_EVENT,
        data: payload,
      })
    } catch (error) {
      this.logger.warn('ai.run_status.stream_failed', {
        conversationId,
        reason: error instanceof Error ? error.message : String(error),
      })
    }
  }
}
