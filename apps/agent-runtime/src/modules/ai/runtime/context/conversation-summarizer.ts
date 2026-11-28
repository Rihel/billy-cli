import type { AppLogger } from '@repo/kits'
import { TimelineKind, TimelineRole } from '@repo/shared'
import type { RuntimeModel } from '../../foundation/envelope.js'
import { runContextCompression } from '../../adapters/mastra/summarizer.js'
import type { TimelineRepository } from '../run/timeline.repository.js'
import { toUsageRecord } from '../run/usage.js'

/** 生成摘要用的指令（只做压缩，不做回答） */
const SUMMARY_INSTRUCTION = `请把上面的对话压缩成一份简明摘要，供后续对话继续使用。
要求：
1. 保留事实（用户是谁、问过什么、结论是什么、涉及的具体数据）；
2. 保留未完成的事项与用户明确的偏好；
3. 不要评价、不要扩写、不要编造；
4. 用简体中文，控制在 500 字以内。`

/** 摘要正文之外，摘要事件还要记住它覆盖了哪一段 */
const SUMMARY_MAX_CHARS = 2_000
/** 摘要调用的输出上限（500 字的摘要给 800 token 足够，防止模型长篇发挥） */
const SUMMARY_MAX_OUTPUT_TOKENS = 800

/** 摘要压缩的最小依赖 */
export interface ConversationSummarizerDeps {
  timelines: TimelineRepository
  logger: AppLogger
}

/** 要压缩的时间线区间（含端点） */
export interface CompactionRange {
  fromSeq: number
  toSeq: number
}

/**
 * 把一段旧对话压缩成摘要事件（原文保留，摘要只作"给模型看的新起点"）。
 *
 * 压缩失败不阻断这一轮：降级为纯裁剪，并记一条状态事件（复盘能看出"这里本该有摘要"）。
 */
export const summarizeConversation = async (
  deps: ConversationSummarizerDeps,
  conversationId: string,
  runId: string,
  range: CompactionRange,
  model: RuntimeModel,
): Promise<void> => {
  const events = await deps.timelines.listRange(conversationId, range.fromSeq, range.toSeq, {
    rootOnly: true,
  })
  const lines: string[] = []
  for (const event of events) {
    if (event.kind === TimelineKind.Text) {
      const text = typeof event.payload?.text === 'string' ? event.payload.text : ''
      if (text) lines.push(`${event.role === TimelineRole.User ? '用户' : '助手'}：${text}`)
    } else if (event.kind === TimelineKind.ToolCall) {
      lines.push(
        `[工具调用] ${event.toolKey ?? '未知'} 入参：${JSON.stringify(event.payload?.input ?? {})}`,
      )
    } else if (event.kind === TimelineKind.ToolResult) {
      lines.push(
        `[工具结果] ${event.toolKey ?? '未知'} 出参：${JSON.stringify(event.payload?.output ?? null)}`,
      )
    }
  }
  if (lines.length === 0) return

  const coversSeqs = [[range.fromSeq, range.toSeq]]
  const startedAt = new Date()
  // 开始压缩：先落一条状态事件。压缩发生在建流之前（客户端还没连上），所以看不到实时帧，
  // 但审计 / 复盘能看出"这一段在做什么"，失败时也能与 compact_failed 对上。
  await deps.timelines.append({
    conversationId,
    runId,
    role: TimelineRole.System,
    kind: TimelineKind.Status,
    payload: { status: 'compacting', coversSeqs, sourceEventCount: events.length },
    startedAt,
  })

  try {
    // 隔离调用：不带工具 / 技能 / 记忆，避免模型在这一步调工具导致摘要为空
    const result = await runContextCompression({
      model,
      instructions: SUMMARY_INSTRUCTION,
      transcript: lines.join('\n'),
      maxOutputTokens: SUMMARY_MAX_OUTPUT_TOKENS,
    })
    const text = ((result.text as string) ?? '').slice(0, SUMMARY_MAX_CHARS)
    if (!text) {
      // 模型返回空：不静默吞掉，留一条状态让复盘能看出"这里本该有摘要"
      await deps.timelines.append({
        conversationId,
        runId,
        role: TimelineRole.System,
        kind: TimelineKind.Status,
        payload: { status: 'compact_empty', coversSeqs },
        finishedAt: new Date(),
      })
      return
    }
    const summary = await deps.timelines.append({
      conversationId,
      runId,
      role: TimelineRole.System,
      kind: TimelineKind.Summary,
      payload: {
        text,
        coversSeqs,
        model: model.modelRef,
        sourceEventCount: events.length,
      },
      usage: toUsageRecord(result.usage as never),
      startedAt,
      finishedAt: new Date(),
      durationMs: Date.now() - startedAt.getTime(),
    })
    await deps.timelines.append({
      conversationId,
      runId,
      role: TimelineRole.System,
      kind: TimelineKind.Status,
      payload: { status: 'compacted', coversSeqs, summarySeq: summary.seq },
      finishedAt: new Date(),
    })
    deps.logger.log('ai.context.compacted', {
      conversationId,
      runId,
      coversSeqs: [range.fromSeq, range.toSeq],
      sourceEventCount: events.length,
      summarySeq: summary.seq,
    })
  } catch (error) {
    // 压缩失败不阻断这一轮：降级为纯裁剪，并记一条状态事件（复盘能看出"这里本该有摘要"）
    deps.logger.warn('ai.context.compact_failed', {
      conversationId,
      runId,
      reason: error instanceof Error ? error.message : String(error),
    })
    await deps.timelines.append({
      conversationId,
      runId,
      role: TimelineRole.System,
      kind: TimelineKind.Status,
      payload: {
        status: 'compact_failed_fallback_trim',
        coversSeqs: [range.fromSeq, range.toSeq],
      },
      finishedAt: new Date(),
    })
  }
}
