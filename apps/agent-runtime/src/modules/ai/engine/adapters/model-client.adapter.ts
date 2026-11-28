import type { RuntimeModel } from '../../foundation/envelope.js'
import { toMastraModelInstance } from '../../adapters/mastra/agent.adapter.js'
import type {
  ModelCallInput,
  ModelClient,
  ModelEvent,
  ModelMessage,
  ModelToolSpec,
} from '../model-client.js'
import type { TokenUsage } from '../types.js'

/** 把消息收成 AI SDK 的 prompt 形状（只映射 Loop 会用到的字段） */
const toPromptMessage = (message: ModelMessage): Record<string, unknown> => {
  if (message.role === 'assistant') {
    return {
      role: 'assistant',
      content: message.content ? [{ type: 'text', text: message.content }] : [],
    }
  }
  if (message.role === 'tool') {
    return {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: message.toolCallId ?? '',
          toolName: message.name ?? '',
          result: message.content,
        },
      ],
    }
  }
  return { role: message.role, content: message.content }
}

/** 工具声明 → AI SDK 的 tools 形状 */
const toToolMap = (
  tools: readonly ModelToolSpec[] | undefined,
): Record<string, unknown> | undefined => {
  if (!tools || tools.length === 0) return undefined
  return Object.fromEntries(
    tools.map((tool) => [
      tool.name,
      { description: tool.description, inputSchema: tool.inputSchema },
    ]),
  )
}

/** 上游 usage → 引擎用量（缺字段按 0，不臆造） */
const toUsage = (usage: unknown): TokenUsage => {
  const record = usage && typeof usage === 'object' ? (usage as Record<string, unknown>) : {}
  const inputTokens = Number(record.inputTokens ?? record.promptTokens ?? 0)
  const outputTokens = Number(record.outputTokens ?? record.completionTokens ?? 0)
  return {
    inputTokens,
    outputTokens,
    totalTokens: Number(record.totalTokens ?? inputTokens + outputTokens),
    ...(Number.isFinite(Number(record.cachedInputTokens))
      ? { cacheReadTokens: Number(record.cachedInputTokens) }
      : {}),
    ...(Number.isFinite(Number(record.reasoningTokens))
      ? { reasoningTokens: Number(record.reasoningTokens) }
      : {}),
  }
}

/** ReadableStream / AsyncIterable 统一成异步迭代器 */
const toAsyncIterable = async function* (stream: unknown): AsyncIterable<unknown> {
  if (stream && typeof (stream as AsyncIterable<unknown>)[Symbol.asyncIterator] === 'function') {
    for await (const chunk of stream as AsyncIterable<unknown>) yield chunk
    return
  }
  if (stream && typeof (stream as ReadableStream<unknown>).getReader === 'function') {
    const reader = (stream as ReadableStream<unknown>).getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        yield value
      }
    } finally {
      reader.releaseLock()
    }
    return
  }
  throw new Error('模型实例的流既不是 ReadableStream 也不是 AsyncIterable')
}

const parseToolInput = (raw: unknown): unknown => {
  if (typeof raw !== 'string') return raw ?? null
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

/**
 * `ModelClient` 的 Mastra / AI SDK 适配器。
 *
 * Loop 只认 `ModelClient`；这个类把供应商/网关实例包起来，并暴露 `mastraInstance`
 * 给仍需要实例的现有执行体（`agent.stream({ model })` 必须拿实例，见适配器注释）。
 */
export class MastraModelClient implements ModelClient {
  constructor(
    readonly ref: string,
    readonly contextWindow: number | null,
    private readonly instance: unknown,
  ) {}

  static async create(model: RuntimeModel): Promise<MastraModelClient> {
    const resolved = await toMastraModelInstance(model)
    return new MastraModelClient(model.modelRef, model.contextWindow ?? null, resolved.instance)
  }

  /** 现有执行体（Mastra agent.stream）需要的模型实例 */
  get mastraInstance(): unknown {
    return this.instance
  }

  async *stream(input: ModelCallInput): AsyncIterable<ModelEvent> {
    const candidate = this.instance as {
      doStream?: (options: Record<string, unknown>) => Promise<{ stream: unknown }>
    }
    if (typeof candidate.doStream !== 'function') {
      throw new Error(`模型实例不支持 doStream（ref=${this.ref}）`)
    }
    const result = await candidate.doStream({
      prompt: input.messages.map(toPromptMessage),
      ...(toToolMap(input.tools) ? { tools: toToolMap(input.tools) } : {}),
      ...(input.signal ? { abortSignal: input.signal } : {}),
      ...(input.maxOutputTokens ? { maxOutputTokens: input.maxOutputTokens } : {}),
    })
    for await (const raw of toAsyncIterable(result.stream)) {
      const chunk = raw as Record<string, unknown>
      switch (chunk.type) {
        case 'text-delta': {
          const delta = String(chunk.textDelta ?? chunk.delta ?? '')
          if (delta) yield { type: 'text', delta }
          break
        }
        case 'reasoning': {
          const delta = String(chunk.textDelta ?? chunk.delta ?? '')
          if (delta) yield { type: 'reasoning', delta }
          break
        }
        case 'tool-call': {
          yield {
            type: 'tool-call',
            toolCallId: String(chunk.toolCallId ?? ''),
            toolName: String(chunk.toolName ?? ''),
            input: parseToolInput(chunk.args ?? chunk.input),
          }
          break
        }
        case 'finish': {
          if (chunk.usage) yield { type: 'usage', usage: toUsage(chunk.usage) }
          yield { type: 'finish', reason: String(chunk.finishReason ?? 'unknown') }
          break
        }
        case 'error': {
          throw new Error(String(chunk.error ?? '模型流返回错误'))
        }
        default:
          break
      }
    }
  }
}
