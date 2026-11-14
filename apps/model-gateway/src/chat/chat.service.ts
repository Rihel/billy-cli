import { Inject, Injectable } from '@nestjs/common'
import { GatewayChatBodySchema, type GatewayUsage } from '@repo/contracts'
import { HttpTransport, type RawStream } from '@repo/http-client'
import { authStyleOf, nanoid } from '@repo/shared'
import { once } from 'node:events'
import type { Response } from 'express'
import { ModelCatalogService } from '../catalog/model.catalog.service.js'
import { ModelGatewayConfig, type ModelGatewayConfigValue } from '../config/app-config.js'
import { ProviderKeyService } from '../keys/provider-key.service.js'
import { ProtocolRegistry } from '../protocols/registry.js'
import { UsageRecorder, type UsageAttribution } from '../usage/usage-recorder.service.js'
import { usageOf } from '../usage/usage.js'
import { tapUpstreamStream } from '../usage/usage-tap.js'

const SSE_HEADERS = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache',
  connection: 'keep-alive',
  'x-accel-buffering': 'no',
}

/** 首字节前可重试的上游状态（换 key 再试） */
const RETRYABLE_STATUS = new Set([401, 403, 408, 409, 429, 500, 502, 503, 504])
const MAX_ATTEMPTS = 2

type RequestHeaders = Record<string, string | string[] | undefined>

/**
 * canonical 对话代理：`POST /v1/models/{modelId}/chat/completions`。
 *
 * 每次上游尝试都：选 key → 转发 → 落一条 `model_gateway_usage`（失败不影响响应）。
 * 首字节前 429/401/5xx 可换 key 重试一次；写头之后不再重试。
 */
@Injectable()
export class ChatService {
  private readonly transport = new HttpTransport()

  constructor(
    @Inject(ModelCatalogService) private readonly catalog: ModelCatalogService,
    @Inject(ProtocolRegistry) private readonly registry: ProtocolRegistry,
    @Inject(ModelGatewayConfig) private readonly config: ModelGatewayConfigValue,
    @Inject(UsageRecorder) private readonly usage: UsageRecorder,
    @Inject(ProviderKeyService) private readonly keys: ProviderKeyService,
  ) {}

  async handle(
    modelId: string,
    rawBody: unknown,
    res: Response,
    headers: RequestHeaders = {},
  ): Promise<void> {
    const parsed = GatewayChatBodySchema.safeParse(rawBody)
    if (!parsed.success) {
      this.fail(res, 400, '请求体不合法：至少需要 messages')
      return
    }
    const body = parsed.data
    const attribution = attributionOf(headers)
    const requestId = nanoid()
    const startedAt = Date.now()
    const target = await this.catalog.resolve(modelId)
    const adapter = this.registry.get(target.entry.protocol)

    const controller = new AbortController()
    const onClose = (): void => controller.abort()
    res.on('close', onClose)

    try {
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        const picked = await this.keys.pick(target.entry.providerId, target.apiKey)
        // 无鉴权的协议（Ollama）允许无 secret；其余必须有 key
        const needsSecret = authStyleOf(target.entry.providerKind) !== 'none'
        if (!picked.secret && needsSecret) {
          await this.usage.record({
            requestId,
            attempt,
            target,
            stream: body.stream === true,
            status: 'rejected',
            usage: null,
            durationMs: Date.now() - startedAt,
            attribution,
          })
          this.fail(res, 503, '该供应商没有可用 key（未配置或额度已用尽）')
          return
        }
        const attemptTarget = { ...target, apiKey: picked.secret }
        const upstream = adapter.buildRequest({ body, target: attemptTarget })

        let raw: RawStream
        try {
          // 统一走 http-client 的原始流：首字节超时、取消、字节透传都在包里
          raw = await this.transport.streamRaw(
            {
              url: upstream.url,
              method: 'POST',
              headers: upstream.headers,
              data: upstream.body,
            },
            { firstByteMs: this.config.firstByteTimeoutMs, signal: controller.signal },
          )
        } catch {
          const aborted = controller.signal.aborted
          await this.usage.record({
            requestId,
            attempt,
            target,
            keyId: picked.keyId,
            stream: body.stream === true,
            status: aborted ? 'aborted' : 'error',
            usage: null,
            durationMs: Date.now() - startedAt,
            attribution,
          })
          this.fail(res, 502, aborted ? '客户端已断开' : '上游首字节超时或连接中断')
          return
        }

        if (raw.status < 200 || raw.status >= 300) {
          const text = await readBodyText(raw.body).catch(() => '')
          await this.usage.record({
            requestId,
            attempt,
            target,
            keyId: picked.keyId,
            stream: body.stream === true,
            status: 'error',
            httpStatus: raw.status,
            usage: null,
            durationMs: Date.now() - startedAt,
            attribution,
          })
          const retryable = RETRYABLE_STATUS.has(raw.status)
          if (retryable && attempt < MAX_ATTEMPTS) {
            await this.keys.penalize(picked.keyId, raw.status)
            continue
          }
          res
            .status(raw.status)
            .type('application/json')
            .send(text || JSON.stringify({ error: { message: '上游返回错误' } }))
          return
        }

        if (body.stream === true) {
          res.writeHead(200, SSE_HEADERS)
          res.flushHeaders?.()
          const tap = tapUpstreamStream(target.entry.protocol, raw.body)
          if (adapter.relayStream) {
            await adapter.relayStream(tap.stream, res, {
              model: target.entry,
              abort: () => controller.abort(),
              idleTimeoutMs: this.config.idleTimeoutMs,
            })
          } else {
            await this.pipe(tap.stream, res, () => controller.abort(), this.config.idleTimeoutMs)
          }
          const firstAt = tap.firstChunkAt()
          const recorded = tap.usage()
          const costMicros = await this.usage.record({
            requestId,
            attempt,
            target,
            keyId: picked.keyId,
            stream: true,
            status: controller.signal.aborted ? 'aborted' : 'success',
            usage: recorded,
            ttftMs: firstAt === null ? null : firstAt - startedAt,
            durationMs: Date.now() - startedAt,
            attribution,
          })
          await this.keys.recordUsage(picked.keyId, recorded?.totalTokens ?? null, costMicros)
          return
        }

        const payload = parseJson(await readBodyText(raw.body))
        const out = adapter.translateJson ? adapter.translateJson(payload, target) : payload
        const recorded: GatewayUsage | null = usageOf(out) ?? usageOf(payload)
        const costMicros = await this.usage.record({
          requestId,
          attempt,
          target,
          keyId: picked.keyId,
          stream: false,
          status: 'success',
          usage: recorded,
          durationMs: Date.now() - startedAt,
          attribution,
        })
        await this.keys.recordUsage(picked.keyId, recorded?.totalTokens ?? null, costMicros)
        res.status(200).json(out)
        return
      }
    } finally {
      res.off('close', onClose)
    }
  }

  /** 字节透传（openai-compatible / deepseek）：带背压与空闲超时 */
  private async pipe(
    body: ReadableStream<Uint8Array>,
    res: Response,
    abort: () => void,
    idleTimeoutMs: number,
  ): Promise<void> {
    const reader = body.getReader()
    let last = Date.now()
    const idle = setInterval(
      () => {
        if (Date.now() - last > idleTimeoutMs) abort()
      },
      Math.min(5_000, Math.max(1_000, idleTimeoutMs)),
    )
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        last = Date.now()
        if (!res.write(Buffer.from(value))) await once(res, 'drain')
      }
      res.end()
    } catch {
      if (!res.writableEnded) res.end()
    } finally {
      clearInterval(idle)
    }
  }

  private fail(res: Response, status: number, message: string): void {
    if (res.writableEnded || res.headersSent) {
      if (!res.writableEnded) res.end()
      return
    }
    res.status(status).json({ error: { message, type: 'gateway_error' } })
  }
}

/** 从 runtime 注入的归因头取上下文（缺失时 usage 行留空，不报错） */
const attributionOf = (headers: RequestHeaders): UsageAttribution => {
  const pick = (name: string): string | null => {
    const value = headers[name]
    const raw = Array.isArray(value) ? value[0] : value
    return raw?.trim() || null
  }
  return {
    runId: pick('x-billy-run-id'),
    conversationId: pick('x-billy-conversation-id'),
    identityType: pick('x-billy-identity-type'),
    identityId: pick('x-billy-identity-id'),
  }
}

/** 读完整响应体文本（非流式 / 错误体） */
const readBodyText = async (body: ReadableStream<Uint8Array>): Promise<string> => {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    text += decoder.decode(value, { stream: true })
  }
  text += decoder.decode()
  return text
}

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}
