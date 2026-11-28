import { encodeAgUiChunk, type AgUiChunk } from '@repo/shared'
import type { Toolbox, ToolLogger } from '../../tools/engine/tools.types.js'
import type { AgentLoop, AgentLoopInput, AgentLoopResult, AgentLoopRun } from '../agent-loop.js'
import type { ModelEvent } from '../model-client.js'
import type { EngineEvent } from '../protocol.js'
import { engineError } from '../engine-errors.js'
import { AsyncEventQueue } from '../run-execution.js'
import type { TokenUsage } from '../types.js'

const noopLogger: ToolLogger = {
  debug: () => undefined,
  log: () => undefined,
  info: () => undefined,
  error: () => undefined,
  warn: () => undefined,
}

/** 工具出参 → 给模型看的一段文本（失败也要能读懂、可纠正） */
const toolResultText = (outcome: unknown): string => {
  const record = outcome && typeof outcome === 'object' ? (outcome as Record<string, unknown>) : {}
  if (record.ok === false) {
    const parts = [record.reason, record.message, record.hint].filter(
      (item): item is string => typeof item === 'string' && item.length > 0,
    )
    return parts.join('：') || '工具执行失败'
  }
  return JSON.stringify(record.data ?? outcome ?? null)
}

/**
 * 薄 AgentLoop（S1 接缝实现）。
 *
 * 只做「调模型 → 执行工具 → 再调模型」的最小循环，产出 AG-UI 事件；
 * 持久化 / 队列 / 恢复都不在 Loop 内。现有主路径仍走 Mastra 的循环（`AgentChatService`），
 * 这个实现用于 S2 替换算法与单测验证接缝；`resume` 暂不支持 durable 快照，直接报
 * `run_not_resumable`，不假装续跑。
 */
export class MastraAgentLoop implements AgentLoop {
  async start(input: AgentLoopInput): Promise<AgentLoopRun> {
    const queue = new AsyncEventQueue<EngineEvent>()
    const controller = new AbortController()
    const signal = AbortSignal.any([input.signal, controller.signal])
    const result = this.run(input, queue, signal)
    result.catch(() => undefined)
    return {
      events: { [Symbol.asyncIterator]: () => queue[Symbol.asyncIterator]() },
      result,
      abort: (reason?: string) => controller.abort(reason),
    }
  }

  async resume(): Promise<AgentLoopRun> {
    throw engineError('run_not_resumable', '薄 AgentLoop 暂不支持从 durable 快照续跑')
  }

  private async run(
    input: AgentLoopInput,
    queue: AsyncEventQueue<EngineEvent>,
    signal: AbortSignal,
  ): Promise<AgentLoopResult> {
    const ctx = { threadId: input.conversationId, runId: input.runId }
    const emit = (chunk: AgUiChunk, messageId?: string): void => {
      for (const event of encodeAgUiChunk(chunk, {
        ...ctx,
        ...(messageId ? { messageId } : {}),
      })) {
        queue.push(event)
      }
    }
    const messages = [...input.messages]
    let text = ''
    let reasoning = ''
    let usage: TokenUsage | null = null
    const stepResults: Array<{
      index: number
      finishReason: string | null
      usage: TokenUsage | null
    }> = []
    let finishReason: string | null = null
    let steps = 0
    let stopReason: AgentLoopResult['stopReason'] = 'done'

    try {
      emit({ type: 'data-run', data: { runId: input.runId, conversationId: input.conversationId } })
      for (;;) {
        if (signal.aborted) {
          stopReason = 'interrupted'
          break
        }
        if (steps >= input.limits.maxSteps) {
          stopReason = 'max_steps'
          break
        }
        steps += 1
        const messageId = `msg_${input.runId}_${steps}`
        emit({ type: 'text-start', id: messageId }, messageId)
        const calls: Array<{ toolCallId: string; toolName: string; input: unknown }> = []
        let stepText = ''
        for await (const event of this.callModel(input, messages, signal)) {
          switch (event.type) {
            case 'text':
              stepText += event.delta
              text += event.delta
              emit({ type: 'text-delta', id: messageId, delta: event.delta }, messageId)
              break
            case 'reasoning':
              reasoning += event.delta
              emit({ type: 'reasoning-delta', id: messageId, delta: event.delta }, messageId)
              break
            case 'tool-call':
              calls.push(event)
              break
            case 'usage':
              usage = event.usage
              break
            case 'finish':
              finishReason = event.reason
              break
          }
        }
        emit({ type: 'text-end', id: messageId }, messageId)
        stepResults.push({ index: stepResults.length, finishReason, usage })
        if (stepText) {
          messages.push({ role: 'assistant', content: stepText })
        }
        if (calls.length === 0) break
        for (const call of calls) {
          messages.push({
            role: 'assistant',
            content: '',
            toolCallId: call.toolCallId,
            name: call.toolName,
          })
          emit(
            {
              type: 'tool-input-start',
              id: call.toolCallId,
              toolCallId: call.toolCallId,
              toolName: call.toolName,
            },
            messageId,
          )
          emit({ type: 'tool-input-available', toolCallId: call.toolCallId }, messageId)
          const outcome = await this.runTool(input.tools, call, input, signal)
          emit(
            outcome.ok
              ? { type: 'tool-output-available', toolCallId: call.toolCallId, output: outcome.data }
              : {
                  type: 'tool-output-error',
                  toolCallId: call.toolCallId,
                  errorText: outcome.message,
                },
            messageId,
          )
          messages.push({
            role: 'tool',
            content: toolResultText(outcome),
            toolCallId: call.toolCallId,
            name: call.toolName,
          })
        }
        if (signal.aborted) {
          stopReason = 'interrupted'
          break
        }
      }
      emit({ type: '__run_end__' })
      queue.close()
      return {
        status: stopReason === 'done' ? 'succeeded' : 'canceled',
        text,
        reasoning,
        steps: stepResults,
        usage,
        finishReason,
        stopReason,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      emit({ type: 'error', errorText: message })
      queue.close()
      return {
        status: 'failed',
        text,
        reasoning,
        steps: stepResults,
        usage,
        finishReason,
        stopReason: 'error',
        error: { code: 'model_failed', message },
      }
    }
  }

  private async *callModel(
    input: AgentLoopInput,
    messages: AgentLoopInput['messages'],
    signal: AbortSignal,
  ): AsyncIterable<ModelEvent> {
    yield* input.model.stream({
      messages,
      signal,
      ...(input.tools
        ? {
            tools: [...input.tools.values()].map((tool) => ({
              name: tool.spec.key,
              description: tool.spec.description,
              inputSchema: tool.spec.modelParams ?? tool.spec.params,
            })),
          }
        : {}),
    })
  }

  private async runTool(
    tools: Toolbox | undefined,
    call: { toolCallId: string; toolName: string; input: unknown },
    input: AgentLoopInput,
    signal: AbortSignal,
  ): Promise<{ ok: true; data: unknown } | { ok: false; message: string }> {
    const tool = tools?.get(call.toolName)
    if (!tool) return { ok: false, message: `未知工具：${call.toolName}` }
    return tool.run(call.input, {
      callId: call.toolCallId,
      envelope: {
        conversationId: input.conversationId,
        runId: input.runId,
        taskId: input.taskId,
        ...(input.scope?.userId ? { userId: input.scope.userId } : {}),
        ...(input.scope?.isAdmin !== undefined ? { isAdmin: input.scope.isAdmin } : {}),
      },
      signal,
      log: noopLogger,
    })
  }
}
