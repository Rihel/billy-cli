import { TimelineKind, TimelineRole } from '@repo/shared'
import type { TimelineEntity } from '../../../database/entities/timeline-entity.js'

/** 回灌的最大消息数（与 thread 的预算无关，只是"够接上话"的保守值） */
export const REHYDRATE_MAX_MESSAGES = 20

/** 回灌给 Mastra `saveMessages` 的消息形状（只含文本，工具由 durable 快照负责） */
export interface RehydrateMessage {
  id: string
  threadId: string
  resourceId: string
  role: 'user' | 'assistant'
  createdAt: Date
  content: {
    format: 2
    parts: Array<{ type: 'text'; text: string }>
  }
}

/**
 * `timelines` → 续跑回灌消息（设计 `docs/design/ai-memory.md` §4.4）。
 *
 * 只取**根 run 的文本**事件：推理、工具调用/结果、计划、摘要都不回灌 ——
 * 工具状态在 durable 快照里，回灌反而可能与快照打架。
 */
export const toRehydrateMessages = (
  events: readonly TimelineEntity[],
  conversationId: string,
  userId: string,
): RehydrateMessage[] => {
  const texts = events.filter(
    (event) =>
      event.kind === TimelineKind.Text &&
      (event.role === TimelineRole.User || event.role === TimelineRole.Assistant) &&
      typeof event.payload?.text === 'string' &&
      event.payload.text.length > 0,
  )
  return texts.slice(-REHYDRATE_MAX_MESSAGES).map((event) => ({
    id: `rehydrate-${conversationId}-${event.seq}`,
    threadId: conversationId,
    resourceId: userId,
    role: event.role as 'user' | 'assistant',
    createdAt: event.createdAt ?? new Date(),
    content: {
      format: 2,
      parts: [{ type: 'text', text: String(event.payload?.text ?? '') }],
    },
  }))
}
