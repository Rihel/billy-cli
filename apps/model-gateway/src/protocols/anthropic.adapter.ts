import { Injectable } from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import type { GatewayChatBody, GatewayProtocol } from '@repo/contracts'
import { AiProviderProtocol, chatPathOf } from '@repo/shared'
import type { Response } from 'express'
import type { GatewayTarget } from '../catalog/model.catalog.service.js'
import {
  authHeaders,
  joinUrl,
  parseToolArguments,
  resolveBaseUrl,
  type ProtocolAdapter,
  type RelayOptions,
  type UpstreamRequest,
} from './types.js'

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined

const asNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])

/** OpenAI 的 content（string / parts）→ 纯文本（system 与 tool_result 用） */
const textOf = (content: unknown): string => {
  if (typeof content === 'string') return content
  return asArray(content)
    .map((part) => asString(asRecord(part).text) ?? '')
    .filter((text) => text.length > 0)
    .join('\n')
}

/** OpenAI 的 text parts → Anthropic text block（空文本不带，Claude 不接受空 block） */
const textBlocksOf = (content: unknown): Record<string, unknown>[] => {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : []
  return asArray(content).flatMap((part) => {
    const row = asRecord(part)
    const text = asString(row.text)
    return row.type === 'text' && text ? [{ type: 'text', text }] : []
  })
}

/** OpenAI 的 image_url → Anthropic image block（data URL 走 base64，http(s) 走 url） */
const imageBlockOf = (url: string): Record<string, unknown> | null => {
  const dataUrl = /^data:([^;,]+);base64,([\s\S]+)$/.exec(url)
  if (dataUrl?.[1] && dataUrl[2]) {
    return {
      type: 'image',
      source: { type: 'base64', media_type: dataUrl[1], data: dataUrl[2] },
    }
  }
  if (/^https?:\/\//i.test(url)) return { type: 'image', source: { type: 'url', url } }
  return null
}

/** OpenAI user content → Anthropic content blocks（保持 part 顺序） */
const userBlocksOf = (content: unknown): Record<string, unknown>[] => {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : []
  const blocks: Record<string, unknown>[] = []
  for (const part of asArray(content)) {
    const row = asRecord(part)
    if (row.type === 'text' && asString(row.text)) {
      blocks.push({ type: 'text', text: row.text })
      continue
    }
    if (row.type !== 'image_url') continue
    const imageUrl = row.image_url
    const url = typeof imageUrl === 'string' ? imageUrl : asString(asRecord(imageUrl).url)
    const block = url ? imageBlockOf(url) : null
    if (block) blocks.push(block)
  }
  return blocks
}

/** OpenAI assistant 消息 → Anthropic text / tool_use blocks */
const assistantBlocksOf = (message: Record<string, unknown>): Record<string, unknown>[] => {
  const blocks = textBlocksOf(message.content)
  asArray(message.tool_calls).forEach((call, index) => {
    const row = asRecord(call)
    const fn = asRecord(row.function)
    blocks.push({
      type: 'tool_use',
      id: asString(row.id) ?? `call_${index}`,
      name: asString(fn.name) ?? '',
      input: parseToolArguments(fn.arguments),
    })
  })
  return blocks
}

interface AnthropicMessages {
  system: string
  messages: Record<string, unknown>[]
}

/**
 * OpenAI messages → Anthropic 顶层 system + messages。
 *
 * Claude 要求 user / assistant 交替且 content 是 block 数组：连续的同类角色合并，
 * `role:'tool'` 的 tool_result 落进 user 消息；空 block 的消息直接丢弃。
 */
const toAnthropicMessages = (messages: readonly Record<string, unknown>[]): AnthropicMessages => {
  const systemParts: string[] = []
  const out: Record<string, unknown>[] = []
  const push = (role: string, blocks: Record<string, unknown>[]): void => {
    if (blocks.length === 0) return
    const last = out[out.length - 1]
    if (last && last.role === role) {
      last.content = [...asArray(last.content), ...blocks]
      return
    }
    out.push({ role, content: blocks })
  }

  for (const raw of messages) {
    const message = asRecord(raw)
    const role = asString(message.role) ?? 'user'
    if (role === 'system') {
      const text = textOf(message.content)
      if (text) systemParts.push(text)
      continue
    }
    if (role === 'tool') {
      const toolUseId = asString(message.tool_call_id)
      if (!toolUseId) continue
      push('user', [
        { type: 'tool_result', tool_use_id: toolUseId, content: textOf(message.content) },
      ])
      continue
    }
    if (role === 'assistant') {
      push('assistant', assistantBlocksOf(message))
      continue
    }
    push('user', userBlocksOf(message.content))
  }

  return { system: systemParts.join('\n\n'), messages: out }
}

/** OpenAI tools → Anthropic tools（function.parameters 即 input_schema） */
const toAnthropicTools = (tools: unknown): Record<string, unknown>[] =>
  asArray(tools).flatMap((tool) => {
    const row = asRecord(tool)
    const fn = asRecord(row.function)
    const name = asString(fn.name)
    if (!name) return []
    const description = asString(fn.description)
    const parameters = asRecord(fn.parameters)
    return [
      {
        name,
        ...(description ? { description } : {}),
        input_schema:
          Object.keys(parameters).length > 0 ? parameters : { type: 'object', properties: {} },
      },
    ]
  })

/** OpenAI tool_choice → Anthropic tool_choice（auto / any / tool） */
const toAnthropicToolChoice = (value: unknown): Record<string, unknown> | null => {
  if (typeof value === 'string') {
    if (value === 'auto') return { type: 'auto' }
    if (value === 'required' || value === 'any') return { type: 'any' }
    if (value === 'none') return { type: 'none' }
    return null
  }
  const row = asRecord(value)
  if (row.type === 'auto' || row.type === 'any' || row.type === 'none') {
    return { type: row.type }
  }
  const name = asString(asRecord(row.function).name) ?? asString(row.name)
  if (name) return { type: 'tool', name }
  return null
}

/** OpenAI 的 stop（string / string[]）→ Anthropic stop_sequences */
const toStopSequences = (stop: unknown): string[] => {
  if (typeof stop === 'string') return stop ? [stop] : []
  return asArray(stop).filter((value): value is string => typeof value === 'string' && !!value)
}

/** OpenAI Chat Completions 请求 → Anthropic `/v1/messages` 请求 */
export const toAnthropicBody = (
  body: GatewayChatBody,
  modelKey: string,
): Record<string, unknown> => {
  const { system, messages } = toAnthropicMessages(body.messages)
  const rawMaxTokens = asNumber(body.max_tokens)
  const maxTokens = rawMaxTokens !== null && rawMaxTokens > 0 ? Math.floor(rawMaxTokens) : 4096
  const tools = toAnthropicTools(body.tools)
  const toolChoice = toAnthropicToolChoice(body.tool_choice)

  const out: Record<string, unknown> = {
    model: modelKey,
    // Claude 必填；OpenAI 侧没给时用 4096 兜底
    max_tokens: maxTokens,
    messages,
    stream: body.stream === true,
  }
  if (system) out.system = system
  if (typeof body.temperature === 'number') out.temperature = body.temperature
  if (typeof body.top_p === 'number') out.top_p = body.top_p
  const stopSequences = toStopSequences(body.stop)
  if (stopSequences.length > 0) out.stop_sequences = stopSequences
  if (tools.length > 0) out.tools = tools
  if (toolChoice) out.tool_choice = toolChoice
  // OpenAI 的 reasoning_effort 只表达"要思考"，Claude 侧给最小可用预算
  if (body.reasoning_effort !== undefined && body.reasoning_effort !== null) {
    out.thinking = { type: 'enabled', budget_tokens: 1024 }
  }
  return out
}

/** Anthropic stop_reason → OpenAI finish_reason */
const mapStopReason = (reason: unknown): string => {
  switch (reason) {
    case 'max_tokens':
      return 'length'
    case 'tool_use':
      return 'tool_calls'
    case 'refusal':
      return 'content_filter'
    default:
      // end_turn / stop_sequence / pause_turn / null
      return 'stop'
  }
}

/** 用量：字段缺失保持 null；额外保留 Anthropic 原始缓存字段供网关记账识别 */
const openAiUsage = (
  input: number | null,
  output: number | null,
  cacheRead: number | null,
  cacheCreate: number | null,
): Record<string, unknown> => ({
  prompt_tokens: input,
  completion_tokens: output,
  total_tokens: input !== null && output !== null ? input + output : null,
  cache_read_input_tokens: cacheRead,
  cache_creation_input_tokens: cacheCreate,
})

interface JsonContext {
  id: string
  created: number
  model: string
}

/** 非流式 Anthropic 响应 → OpenAI 响应 */
export const anthropicResponseToOpenai = (
  payload: unknown,
  ctx: JsonContext,
): Record<string, unknown> => {
  const row = asRecord(payload)
  const texts: string[] = []
  const thinking: string[] = []
  const toolCalls: Record<string, unknown>[] = []

  for (const block of asArray(row.content)) {
    const item = asRecord(block)
    if (item.type === 'text') {
      const text = asString(item.text)
      if (text) texts.push(text)
      continue
    }
    if (item.type === 'thinking') {
      const thought = asString(item.thinking)
      if (thought) thinking.push(thought)
      continue
    }
    if (item.type === 'tool_use') {
      const index = toolCalls.length
      toolCalls.push({
        index,
        id: asString(item.id) ?? `call_${index}`,
        type: 'function',
        function: {
          name: asString(item.name) ?? '',
          arguments: JSON.stringify(item.input ?? {}),
        },
      })
    }
  }

  const message: Record<string, unknown> = {
    role: 'assistant',
    content: texts.join(''),
    ...(thinking.length > 0 ? { reasoning_content: thinking.join('') } : {}),
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  }
  const usage = asRecord(row.usage)

  return {
    id: asString(row.id) ?? ctx.id,
    object: 'chat.completion',
    created: ctx.created,
    model: ctx.model,
    choices: [{ index: 0, message, finish_reason: mapStopReason(row.stop_reason) }],
    usage: openAiUsage(
      asNumber(usage.input_tokens),
      asNumber(usage.output_tokens),
      asNumber(usage.cache_read_input_tokens),
      asNumber(usage.cache_creation_input_tokens),
    ),
  }
}

/** 流式累计状态：工具块 id/name 缓存 + 跨事件的 usage */
export interface AnthropicStreamState {
  id: string
  created: number
  model: string
  toolUse: Map<number, { id: string; name: string }>
  inputTokens: number | null
  outputTokens: number | null
  cacheReadInputTokens: number | null
  cacheCreationInputTokens: number | null
  usageSeen: boolean
}

export const createAnthropicStreamState = (ctx: JsonContext): AnthropicStreamState => ({
  ...ctx,
  toolUse: new Map(),
  inputTokens: null,
  outputTokens: null,
  cacheReadInputTokens: null,
  cacheCreationInputTokens: null,
  usageSeen: false,
})

const usageOfState = (state: AnthropicStreamState): Record<string, unknown> =>
  openAiUsage(
    state.inputTokens,
    state.outputTokens,
    state.cacheReadInputTokens,
    state.cacheCreationInputTokens,
  )

const streamChunk = (
  state: AnthropicStreamState,
  delta: Record<string, unknown>,
  finishReason: string | null = null,
  usage?: Record<string, unknown>,
): Record<string, unknown> => ({
  id: state.id,
  object: 'chat.completion.chunk',
  created: state.created,
  model: state.model,
  choices: [{ index: 0, delta, finish_reason: finishReason }],
  ...(usage ? { usage } : {}),
})

/** 一个 Anthropic SSE 事件 → 一个 OpenAI chunk（无对应帧返回 null） */
export const anthropicEventToOpenai = (
  payload: unknown,
  state: AnthropicStreamState,
): Record<string, unknown> | null => {
  const event = asRecord(payload)
  switch (event.type) {
    case 'message_start': {
      const message = asRecord(event.message)
      state.id = asString(message.id) ?? state.id
      const usage = asRecord(message.usage)
      if (Object.keys(usage).length > 0) {
        state.usageSeen = true
        // 输入 / 缓存来自 message_start；输出以 message_delta 的累计值为准
        state.inputTokens = asNumber(usage.input_tokens) ?? state.inputTokens
        state.cacheReadInputTokens =
          asNumber(usage.cache_read_input_tokens) ?? state.cacheReadInputTokens
        state.cacheCreationInputTokens =
          asNumber(usage.cache_creation_input_tokens) ?? state.cacheCreationInputTokens
      }
      return streamChunk(state, { role: 'assistant' })
    }
    case 'content_block_start': {
      const index = asNumber(event.index) ?? 0
      const block = asRecord(event.content_block)
      if (block.type !== 'tool_use') return null
      const id = asString(block.id) ?? `call_${index}`
      const name = asString(block.name) ?? ''
      state.toolUse.set(index, { id, name })
      return streamChunk(state, {
        tool_calls: [{ index, id, type: 'function', function: { name, arguments: '' } }],
      })
    }
    case 'content_block_delta': {
      const index = asNumber(event.index) ?? 0
      const delta = asRecord(event.delta)
      if (delta.type === 'text_delta') {
        const text = asString(delta.text)
        return text ? streamChunk(state, { content: text }) : null
      }
      if (delta.type === 'thinking_delta') {
        const thought = asString(delta.thinking)
        return thought ? streamChunk(state, { reasoning_content: thought }) : null
      }
      if (delta.type === 'input_json_delta') {
        const tool = state.toolUse.get(index) ?? { id: `call_${index}`, name: '' }
        return streamChunk(state, {
          tool_calls: [
            {
              index,
              id: tool.id,
              type: 'function',
              // 参数分片原样透传，由客户端拼成完整 JSON
              function: { name: tool.name, arguments: asString(delta.partial_json) ?? '' },
            },
          ],
        })
      }
      return null
    }
    case 'message_delta': {
      const usage = asRecord(event.usage)
      if (Object.keys(usage).length > 0) {
        state.usageSeen = true
        state.outputTokens = asNumber(usage.output_tokens) ?? state.outputTokens
        state.cacheReadInputTokens =
          asNumber(usage.cache_read_input_tokens) ?? state.cacheReadInputTokens
        state.cacheCreationInputTokens =
          asNumber(usage.cache_creation_input_tokens) ?? state.cacheCreationInputTokens
      }
      return streamChunk(
        state,
        {},
        mapStopReason(asRecord(event.delta).stop_reason),
        state.usageSeen ? usageOfState(state) : undefined,
      )
    }
    default:
      return null
  }
}

const safeJson = (raw: string): unknown => {
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return null
  }
}

/**
 * Anthropic SSE（`event:` + `data:`）→ OpenAI SSE。
 *
 * 返回最后累计的 OpenAI usage（没有 usage 事件时 null）；`ProtocolAdapter.relayStream`
 * 的接口签名是 `Promise<void>`（types.ts），类里只在内部 await，不把值暴露给调用方，
 * 后续记账接入时可直接复用这个函数。
 */
export const relayAnthropicStream = async (
  upstream: ReadableStream<Uint8Array>,
  res: Response,
  options: RelayOptions,
): Promise<Record<string, unknown> | null> => {
  const state = createAnthropicStreamState({
    id: `chatcmpl-${randomUUID()}`,
    created: Math.floor(Date.now() / 1000),
    model: options.model.modelKey,
  })
  const reader = upstream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let eventName = ''
  let dataLines: string[] = []
  let last = Date.now()
  let finished = false
  const idle = setInterval(
    () => {
      if (Date.now() - last > options.idleTimeoutMs) options.abort()
    },
    Math.min(5_000, Math.max(1_000, options.idleTimeoutMs)),
  )

  const writeChunk = async (chunk: Record<string, unknown> | null): Promise<void> => {
    if (!chunk || res.writableEnded) return
    if (!res.write(`data: ${JSON.stringify(chunk)}\n\n`)) await once(res, 'drain')
  }
  const finish = (): void => {
    if (finished) return
    finished = true
    if (res.writableEnded) return
    res.write('data: [DONE]\n\n')
    res.end()
  }

  /** 一个空行 = 一帧结束；data 可能有多个字段，按 SSE 规范用 \n 拼 */
  const dispatch = async (): Promise<void> => {
    if (dataLines.length === 0) {
      eventName = ''
      return
    }
    const payload = safeJson(dataLines.join('\n'))
    const fallbackType = eventName
    dataLines = []
    eventName = ''
    if (!payload) return
    const type = asString(asRecord(payload).type) ?? fallbackType
    if (type === 'message_stop') {
      finish()
      return
    }
    await writeChunk(anthropicEventToOpenai(payload, state))
  }

  const handleLine = async (rawLine: string): Promise<void> => {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (line === '') {
      await dispatch()
      return
    }
    if (line.startsWith('event:')) {
      eventName = line.slice('event:'.length).trim()
      return
    }
    if (line.startsWith('data:')) {
      dataLines.push(line.slice('data:'.length).replace(/^ /, ''))
    }
    // id: / retry: / 注释行忽略
  }

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      last = Date.now()
      buffer += decoder.decode(value, { stream: true })
      let index = buffer.indexOf('\n')
      while (index >= 0) {
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        await handleLine(line)
        if (finished) break
        index = buffer.indexOf('\n')
      }
      if (finished) break
    }
    if (!finished) {
      for (const line of buffer.split('\n')) {
        await handleLine(line)
        if (finished) break
      }
      if (!finished) await dispatch()
      finish()
    }
  } catch {
    finish()
  } finally {
    clearInterval(idle)
  }

  return state.usageSeen ? usageOfState(state) : null
}

/**
 * Anthropic Messages API 适配器。
 *
 * - 请求：OpenAI Chat Completions → Claude `/v1/messages`（system 顶层、max_tokens 必填、
 *   tool_use / tool_result、图片 base64、thinking）；
 * - 流式：逐事件翻译成 OpenAI SSE（`data: ...\n\n`），收到 `message_stop` 或流结束时补 `[DONE]`；
 * - 非流式：Anthropic message → OpenAI chat.completion，缓存 token 保留原始字段。
 */
@Injectable()
export class AnthropicAdapter implements ProtocolAdapter {
  readonly protocol: GatewayProtocol = AiProviderProtocol.Anthropic

  buildRequest(input: { body: GatewayChatBody; target: GatewayTarget }): UpstreamRequest {
    const { body, target } = input
    return {
      url: joinUrl(resolveBaseUrl(target), chatPathOf(target.entry.providerKind)),
      headers: {
        'content-type': 'application/json',
        ...authHeaders(target),
      },
      body: toAnthropicBody(body, target.entry.modelKey),
    }
  }

  /** 接口约定返回 void；usage 由 relayAnthropicStream 的返回值提供（见其注释） */
  async relayStream(
    upstream: ReadableStream<Uint8Array>,
    res: Response,
    options: RelayOptions,
  ): Promise<void> {
    await relayAnthropicStream(upstream, res, options)
  }

  translateJson(payload: unknown, target: GatewayTarget): unknown {
    return anthropicResponseToOpenai(payload, {
      id: `chatcmpl-${randomUUID()}`,
      created: Math.floor(Date.now() / 1000),
      model: target.entry.modelKey,
    })
  }
}
