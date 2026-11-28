import { RunStatus, TimelineRole, type AgentRunSnapshotModel } from '@repo/shared'
import type { StreamPublisher } from '../../engine/ports.js'
import type { RunRepository } from './run.repository.js'
import type { TimelineRepository } from './timeline.repository.js'
import type { AgentConversationService } from '../conversation/conversation.service.js'
import { buildRunSnapshot } from './run-snapshot.js'
import { buildMessageParts } from '../context/message-snapshot.js'
import { RunNotFoundError } from '../../foundation/errors.js'

/** 快照读取的依赖 */
export interface RunSnapshotDeps {
  runs: RunRepository
  conversations: AgentConversationService
  streams: StreamPublisher
  timelines: TimelineRepository
}

/**
 * 快照的持久化来源：`timelines` 里的**全部已闭合 part** + assistant 消息 id。
 *
 * 与前端 `history.ts` 同一套映射（`buildMessageParts`）；输出记录只负责算 `sinceRev`，
 * 不再承担“快照”职责 —— 它有 20k 上限，长轮次会被裁掉头部。
 */
export const loadSnapshotData = async (
  deps: RunSnapshotDeps,
  runId: string,
): Promise<{ messageId?: string; parts?: Array<Record<string, unknown>> }> => {
  const items = await deps.timelines.listByRun(runId)
  const messageId =
    items.find((item) => item.role === TimelineRole.Assistant && item.messageId)?.messageId ?? null
  const parts = buildMessageParts(items)
  return {
    ...(messageId ? { messageId } : {}),
    ...(parts.length > 0 ? { parts } : {}),
  }
}

/**
 * 正在跑的那一轮的「已闭合内容快照」。
 *
 * 前端拿到它先渲染已完成的部分，再从 `sinceRev` 接增量 —— 不必整轮重放。
 * 没有进行中的轮（或已收尾）返回 null：调用方据此不要点亮"恢复中"。
 */
export const snapshotRun = async (
  deps: RunSnapshotDeps,
  userId: string,
  runId: string,
): Promise<AgentRunSnapshotModel | null> => {
  const run = await deps.runs.findEntity(runId)
  if (!run) throw new RunNotFoundError(runId)
  await deps.conversations.requireOwned(userId, run.conversationId)
  if (run.status !== RunStatus.Running && run.status !== RunStatus.Pending) return null
  const progress = await deps.streams.readRun(runId)
  if (!progress || progress.status !== RunStatus.Running) return null
  /**
   * 快照要同时读时间线（parts）和输出记录（sinceRev），两个数据源之间有毫秒级窗口：
   * 期间若有一个 part 闭合，可能出现"时间线已含、记录也含"的重叠。合闸门让产事件的一侧
   * 先停一下，两次读拿到同一时刻的视图（`buildRunSnapshot` 里还有按 part id 的兜底去重）。
   */
  await deps.streams.beginReplay(runId)
  try {
    const [snapshotData, records] = await Promise.all([
      loadSnapshotData(deps, runId),
      deps.streams.readAllEvents(runId),
    ])
    return buildRunSnapshot(run.id, records, snapshotData).snapshot
  } finally {
    await deps.streams.endReplay(runId)
  }
}

/** 按会话找"当前进行中的那一轮"再取快照（前端只知道会话 id 时用） */
export const snapshotCurrentRun = async (
  deps: RunSnapshotDeps,
  userId: string,
  conversationId?: string,
): Promise<AgentRunSnapshotModel | null> => {
  const active = conversationId
    ? await deps.runs.findActiveByConversation(userId, conversationId)
    : await deps.runs.findActiveByUser(userId)
  if (!active) return null
  return snapshotRun(deps, userId, active.id)
}
