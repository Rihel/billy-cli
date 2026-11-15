import { Injectable } from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import type { GatewayChatBody, GatewayProtocol } from '@repo/contracts'
import { AiProviderProtocol } from '@repo/shared'
import type { Response } from 'express'
import type { GatewayTarget } from '../catalog/model.catalog.service.js'
import {
  joinUrl,
  parseToolArguments,
  resolveBaseUrl,
  type ProtocolAdapter,
  type RelayOptions,
  type UpstreamRequest,
} from './types.js'

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {}

/**
 * OpenAI assistant 的 `tool_calls` → Ollama 形态。
 *
 * **Ollama 的 `function.arguments` 要对象**（OpenAI 是 JSON 字符串）：原样透传会被上游拒
 * （`Value looks like object, but can't find closing '}' symbol`，2026-11-15 实测），
 * 于是「调工具 → 拿结果 → 再问」的第二轮必挂。`id` / `type` / `index` 是 OpenAI 才有的字段，收掉。
 */
const toOllamaToolCalls = (value: unknown): Record<string, unknown>[] | null => {
  const calls = Array.isArray(value) ? value : []
  if (calls.length === 0) return null
  return calls.map((call) => {
    const fn = asRecord(asRecord(call).function)
    return {
      function: {
        name: asString(fn.name) ?? '',
        arguments: parseToolArguments(fn.arguments),
      },
    }
  })
}

/** OpenAI 的 content（string / parts）→ Ollama 的 content + images(base64)，tool_calls 转对象 */
const toOllamaMessages = (
  messages: readonly Record<string, unknown>[],
): Record<string, unknown>[] =>
  messages.map((message) => {
    const content = message.content
    const toolCalls = toOllamaToolCalls(message.tool_calls)
    const base: Record<string, unknown> = { ...message }
    delete base.tool_calls
    const toolField = toolCalls ? { tool_calls: toolCalls } : {}
    if (typeof content === 'string') return { ...base, content, ...toolField }
    const parts = Array.isArray(content) ? content : []
    const texts: string[] = []
    const images: string[] = []
    for (const part of parts) {
      const row = asRecord(part)
      if (row.type === 'text' && typeof row.text === 'string') texts.push(row.text)
      if (row.type === 'image_url') {
        const imageUrl = row.image_url
        const url = typeof imageUrl === 'string' ? imageUrl : asString(asRecord(imageUrl).url)
        const matched = url ? /^data:[^;]+;base64,(.*)$/.exec(url) : null
        if (matched?.[1]) images.push(matched[1])
      }
    }
    return {
      ...base,
      content: texts.join('\n'),
      ...(images.length > 0 ? { images } : {}),
      ...toolField,
    }
  })

/** OpenAI 请求 → Ollama `/api/chat` 请求 */
export const toOllamaBody = (body: GatewayChatBody, modelKey: string): Record<string, unknown> => {
  const options: Record<string, unknown> = {}
  if (typeof body.temperature === 'number') options.temperature = body.temperature
  if (typeof body.top_p === 'number') options.top_p = body.top_p
  if (typeof body.max_tokens === 'number') options.num_predict = body.max_tokens
  if (body.stop !== undefined) options.stop = body.stop

  const format = asRecord(body.response_format)
  const jsonMode = format.type === 'json_object'

  return {
    model: modelKey,
    messages: toOllamaMessages(body.messages),
    stream: body.stream === true,
    ...(Object.keys(options).length > 0 ? { options } : {}),
    ...(body.tools !== undefined ? { tools: body.tools } : {}),
    ...(jsonMode ? { format: 'json' } : {}),
  }
}

/** Ollama 的 done_reason → OpenAI finish_reason */
const mapDoneReason = (reason: unknown): string => (reason === 'length' ? 'length' : 'stop')

/** Ollama 用量 → OpenAI usage（字段缺失保持 null，不编造 0） */
const usageOf = (payload: Record<string, unknown>): Record<string, unknown> => {
  const input = typeof payload.prompt_eval_count === 'number' ? payload.prompt_eval_count : null
  const output = typeof payload.eval_count === 'number' ? payload.eval_count : null
  return {
    prompt_tokens: input,
    completion_tokens: output,
    total_tokens: input !== null && output !== null ? input + output : null,
  }
}

interface ChunkContext {
  id: string
  created: number
  model: string
}

const toolCallsOf = (message: Record<string, unknown>): Record<string, unknown>[] | null => {
  const calls = Array.isArray(message.tool_calls) ? message.tool_calls : []
  if (calls.length === 0) return null
  return calls.map((call, index) => {
    const row = asRecord(call)
    const fn = asRecord(row.function)
    return {
      index,
      id: asString(row.id) ?? `call_${index}`,
      type: 'function',
      function: {
        name: asString(fn.name) ?? '',
        // Ollama 给的是对象；OpenAI 的 arguments 必须是字符串
        arguments:
          typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments ?? {}),
      },
    }
  })
}

/** 一行 Ollama 流式 JSON → 一个 OpenAI chunk（无内容返回 null） */
export const ollamaChunkToOpenai = (
  payload: unknown,
  ctx: ChunkContext,
): Record<string, unknown> | null => {
  const row = asRecord(payload)
  const message = asRecord(row.message)
  const delta: Record<string, unknown> = {}
  const content = asString(message.content)
  if (content) delta.content = content
  const thinking = asString(message.thinking)
  if (thinking) delta.reasoning_content = thinking
  const toolCalls = toolCallsOf(message)
  if (toolCalls) delta.tool_calls = toolCalls

  const done = row.done === true
  if (!done && Object.keys(delta).length === 0) return null
  return {
    id: ctx.id,
    object: 'chat.completion.chunk',
    created: ctx.created,
    model: ctx.model,
    choices: [
      {
        index: 0,
        delta,
        finish_reason: done ? mapDoneReason(row.done_reason) : null,
      },
    ],
    ...(done ? { usage: usageOf(row) } : {}),
  }
}

/** 非流式 Ollama 响应 → OpenAI 响应 */
export const ollamaResponseToOpenai = (
  payload: unknown,
  ctx: ChunkContext,
): Record<string, unknown> => {
  const row = asRecord(payload)
  const message = asRecord(row.message)
  const thinking = asString(message.thinking)
  const toolCalls = toolCallsOf(message)
  return {
    id: ctx.id,
    object: 'chat.completion',
    created: ctx.created,
    model: ctx.model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: asString(message.content) ?? '',
          ...(thinking ? { reasoning_content: thinking } : {}),
          ...(toolCalls ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: mapDoneReason(row.done_reason),
      },
    ],
    usage: usageOf(row),
  }
}

/**
 * Ollama 原生协议：`/api/chat`，流式是 **NDJSON**（每行一个 JSON），不是 SSE。
 *
 * 网关负责把每一行翻译成 OpenAI SSE 帧（`data: ...\n\n`），runtime 侧仍按 OpenAI 解析。
 */
@Injectable()
export class OllamaAdapter implements ProtocolAdapter {
  readonly protocol: GatewayProtocol = AiProviderProtocol.Ollama

  buildRequest(input: { body: GatewayChatBody; target: GatewayTarget }): UpstreamRequest {
    const { body, target } = input
    return {
      url: joinUrl(resolveBaseUrl(target), '/api/chat'),
      headers: {
        'content-type': 'application/json',
        accept: body.stream === true ? 'application/x-ndjson' : 'application/json',
      },
      body: toOllamaBody(body, target.entry.modelKey),
    }
  }

  async relayStream(
    upstream: ReadableStream<Uint8Array>,
    res: Response,
    options: RelayOptions,
  ): Promise<void> {
    const ctx: ChunkContext = {
      id: `chatcmpl-${randomUUID()}`,
      created: Math.floor(Date.now() / 1000),
      model: options.model.modelKey,
    }
    const reader = upstream.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let last = Date.now()
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
      if (res.writableEnded) return
      res.write('data: [DONE]\n\n')
      res.end()
    }

    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        last = Date.now()
        buffer += decoder.decode(value, { stream: true })
        let index = buffer.indexOf('\n')
        while (index >= 0) {
          const line = buffer.slice(0, index).trim()
          buffer = buffer.slice(index + 1)
          if (line) {
            const payload = safeJson(line)
            if (payload) {
              await writeChunk(ollamaChunkToOpenai(payload, ctx))
              if (asRecord(payload).done === true) {
                finish()
                return
              }
            }
          }
          index = buffer.indexOf('\n')
        }
      }
      const tail = buffer.trim()
      if (tail) {
        const payload = safeJson(tail)
        if (payload) await writeChunk(ollamaChunkToOpenai(payload, ctx))
      }
      finish()
    } catch {
      finish()
    } finally {
      clearInterval(idle)
    }
  }

  translateJson(payload: unknown, target: GatewayTarget): unknown {
    return ollamaResponseToOpenai(payload, {
      id: `chatcmpl-${randomUUID()}`,
      created: Math.floor(Date.now() / 1000),
      model: target.entry.modelKey,
    })
  }
}

const safeJson = (line: string): unknown => {
  try {
    return JSON.parse(line) as unknown
  } catch {
    return null
  }
}
