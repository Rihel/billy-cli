import type { GatewayChatBody, GatewayModelEntry, GatewayProtocol } from '@repo/contracts'
import { ServiceUnavailableException } from '@nestjs/common'
import type { Response } from 'express'
import { authStyleOf, chatPathOf, PROVIDER_ENDPOINTS } from '@repo/shared'
import type { GatewayTarget } from '../catalog/model.catalog.service.js'

export interface UpstreamRequest {
  url: string
  headers: Record<string, string>
  body: unknown
}

export interface RelayOptions {
  model: GatewayModelEntry
  /** 中断上游（空闲超时 / 客户端断开） */
  abort: () => void
  idleTimeoutMs: number
}

/**
 * 线路协议适配器。
 *
 * - 不实现 `relayStream` / `translateJson` = **字节透传**（openai-compatible / deepseek）；
 * - 实现 = 逐事件/逐行翻译成 OpenAI SSE（ollama / anthropic）。
 */
export interface ProtocolAdapter {
  readonly protocol: GatewayProtocol
  buildRequest(input: { body: GatewayChatBody; target: GatewayTarget }): UpstreamRequest
  relayStream?(
    upstream: ReadableStream<Uint8Array>,
    res: Response,
    options: RelayOptions,
  ): Promise<void>
  translateJson?(payload: unknown, target: GatewayTarget): unknown
}

/** 供应商地址：行里配了优先，否则用 kind 的默认画像 */
export const resolveBaseUrl = (target: GatewayTarget): string => {
  const configured = target.baseUrl?.trim()
  if (configured) return configured
  const fallback = PROVIDER_ENDPOINTS[target.entry.providerKind]?.baseUrl?.trim()
  if (fallback) return fallback
  throw new ServiceUnavailableException(
    `供应商「${target.entry.providerName}」缺少 baseUrl，请在后台「模型管理」补上`,
  )
}

export const joinUrl = (base: string, path: string): string =>
  `${base.replace(/\/+$/, '')}${path.startsWith('/') ? path : `/${path}`}`

/** 按画像注入上游鉴权；缺密钥直接 503（而不是把空串发给供应商） */
export const authHeaders = (target: GatewayTarget): Record<string, string> => {
  const style = authStyleOf(target.entry.providerKind)
  if (style === 'none') return {}
  const key = target.apiKey?.trim()
  if (!key) {
    throw new ServiceUnavailableException(
      `供应商「${target.entry.providerName}」未配置密钥，请先在后台「模型管理」补上`,
    )
  }
  if (style === 'x-api-key') {
    return { 'x-api-key': key, 'anthropic-version': '2023-06-01' }
  }
  return { authorization: `Bearer ${key}` }
}

/**
 * OpenAI 的 `tool_calls[].function.arguments`（JSON 字符串）→ 对象。
 *
 * 原生协议的**请求侧**都收对象（Anthropic 的 `tool_use.input`、Ollama 的 `function.arguments`），
 * 而 OpenAI 形态里它是字符串；坏 JSON 用 `{}` 兜底（宁可让上游报参数校验，也别把整条请求弄挂）。
 */
export const parseToolArguments = (value: unknown): Record<string, unknown> => {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  if (typeof value !== 'string' || !value.trim()) return {}
  try {
    const parsed = JSON.parse(value) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

/** OpenAI 兼容族（含 DeepSeek）的公共构造：替换 model、注入鉴权、按 stream 加 accept */
export const buildOpenAiRequest = (input: {
  body: GatewayChatBody
  target: GatewayTarget
}): UpstreamRequest => {
  const { body, target } = input
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...authHeaders(target),
  }
  if (body.stream === true) headers.accept = 'text/event-stream'
  return {
    url: joinUrl(resolveBaseUrl(target), chatPathOf(target.entry.providerKind)),
    headers,
    body: { ...body, model: target.entry.modelKey },
  }
}
