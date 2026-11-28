import { TimelineKind, TimelineRole } from '@repo/shared'
import { toPlanPayload } from '../common/plan.protocol.js'
import type { TimelineRepository } from '../run/timeline.repository.js'
import { toUsageRecord } from '../run/usage.js'

/** Mastra step 结果的最小结构（只取我们要落库的字段，避免把它的内部类型铺满调用方） */
export interface StepLike {
  text?: string
  reasoning?: Array<{ payload?: { text?: string } }>
  toolCalls?: Array<{
    payload?: { toolCallId?: string; toolName?: string; args?: unknown }
  }>
  toolResults?: Array<{
    payload?: {
      toolCallId?: string
      toolName?: string
      result?: unknown
      isError?: boolean
    }
  }>
  usage?: unknown
  finishReason?: string
}

/** 步级落库的最小依赖 */
export interface StepPersisterDeps {
  timelines: TimelineRepository
}

/** 汇总一步里的推理增量文本 */
const joinReasoning = (step: StepLike): string =>
  (step.reasoning ?? [])
    .map((chunk) => (typeof chunk.payload?.text === 'string' ? chunk.payload.text : ''))
    .join('')
    .trim()

/**
 * 把 Mastra 的 step 结果拆成时间线事件（文本 / 推理 / 工具调用与结果 / 每步用量）。
 *
 * 非流式路径的落库口径；流式路径由 `StreamRecorder` 逐片段写，两者最终形状一致。
 */
export const persistSteps = async (
  deps: StepPersisterDeps,
  conversationId: string,
  runId: string,
  steps: StepLike[],
): Promise<{ toolCallCount: number }> => {
  let toolCallCount = 0
  for (const [index, step] of steps.entries()) {
    const messageId = `msg_${runId}_${index}`
    const items: Array<Record<string, unknown>> = []

    // 推理（只审计；组装上下文时不回灌，见 ContextService）
    const reasoning = joinReasoning(step)
    if (reasoning) {
      items.push({
        role: TimelineRole.Assistant,
        kind: TimelineKind.Reasoning,
        messageId,
        // `id` 与流式路径同一口径（`stream-recorder` 的 `payload.id`）：恢复时快照与增量
        // 按 part id 去重，缺了它同一段会被补两遍。非流式没有流式 part id，用派生 id 即可
        // —— 唯一性范围是一条消息，`messageId` 已经按 run + 步号唯一。
        payload: { text: reasoning, id: `${messageId}:reasoning` },
      })
    }
    if (step.text) {
      items.push({
        role: TimelineRole.Assistant,
        kind: TimelineKind.Text,
        messageId,
        payload: { text: step.text, id: `${messageId}:text` },
      })
    }
    for (const call of step.toolCalls ?? []) {
      const payload = call.payload ?? {}
      toolCallCount += 1
      items.push({
        role: TimelineRole.Assistant,
        kind: TimelineKind.ToolCall,
        messageId,
        toolKey: payload.toolName ?? null,
        toolCallId: payload.toolCallId ?? null,
        payload: {
          toolCallId: payload.toolCallId ?? null,
          toolName: payload.toolName ?? null,
          input: payload.args ?? null,
        },
      })
    }
    for (const toolResult of step.toolResults ?? []) {
      const payload = toolResult.payload ?? {}
      items.push({
        role: TimelineRole.Assistant,
        kind: TimelineKind.ToolResult,
        messageId,
        state: payload.isError ? 'output-error' : 'output-available',
        toolKey: payload.toolName ?? null,
        toolCallId: payload.toolCallId ?? null,
        payload: {
          toolCallId: payload.toolCallId ?? null,
          toolName: payload.toolName ?? null,
          // **出参完整落库，不裁剪**
          output: payload.result ?? null,
          isError: payload.isError ?? false,
        },
      })
      // 规划能力：write-plan 的输出额外落一条 `plan` 事件 —— **当前计划 = 最后一条 plan 事件**，
      // 且"什么时候把哪一步标成完成"成为可复盘的历史
      const plan = toPlanPayload(payload.toolName ?? null, payload.result)
      if (plan) {
        items.push({
          role: TimelineRole.Assistant,
          kind: TimelineKind.Plan,
          messageId,
          payload: plan as unknown as Record<string, unknown>,
        })
      }
    }
    // 每个模型调用步落一行（带该步的 token 与边界）
    items.push({
      role: TimelineRole.Assistant,
      kind: TimelineKind.Step,
      messageId,
      usage: toUsageRecord(step.usage as Record<string, unknown> | undefined),
      payload: {
        stepIndex: index,
        finishReason: step.finishReason ?? null,
      },
    })

    const finishedAt = new Date()
    await deps.timelines.appendMany(
      items.map((item) => ({
        conversationId,
        runId,
        messageId,
        startedAt: finishedAt,
        finishedAt,
        ...item,
      })) as never,
    )
  }
  return { toolCallCount }
}
