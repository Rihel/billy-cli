import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import type { Response } from 'express'
import { AnyAuthGuard } from '../modules/auth/index.js'
import { RateLimit, RateLimitGuard } from '../common/security/index.js'
import { requestContext } from '@repo/kits'
import { AgentSseBridge } from './agent-sse.bridge.js'

const SSE_HEADERS = {
  'content-type': 'text/event-stream',
  'cache-control': 'no-cache',
  connection: 'keep-alive',
  'x-vercel-ai-ui-message-stream': 'v1',
  'x-accel-buffering': 'no',
}

/** 会话控制：停止 / 回答问题续跑 / 断线重连；全部由 main 鉴权后转内部接口 */
@Controller('agent')
@UseGuards(AnyAuthGuard)
export class AgentControlController {
  constructor(@Inject(AgentSseBridge) private readonly bridge: AgentSseBridge) {}

  @Post('chat')
  @HttpCode(200)
  @UseGuards(RateLimitGuard)
  @RateLimit({ scope: 'agent-chat', limit: 10, windowSeconds: 60, identity: 'user' })
  chat(@Body() body: unknown) {
    return this.callJson('/internal/agent/chat', body)
  }

  @Post('run/stop')
  @HttpCode(200)
  stop(@Body() body: { runId: string }) {
    return this.callJson('/internal/agent/run/stop', body)
  }

  @Post('chat/resume')
  @HttpCode(200)
  async resume(
    @Body() body: unknown,
    @Headers() headers: Record<string, string>,
    @Res() response: Response,
  ): Promise<void> {
    const clientId = randomUUID()
    response.writeHead(200, SSE_HEADERS)
    response.flushHeaders()
    if (!this.kafkaEnabled()) {
      await this.relay('/internal/agent/chat/resume', 'POST', body, response)
      return
    }
    this.bridge.attach(clientId, response)
    try {
      const upstream = await fetch(`${this.runtime()}/internal/agent/chat/resume`, {
        method: 'POST',
        headers: this.headers(clientId, headers),
        body: JSON.stringify(body ?? {}),
      })
      if (!upstream.ok || !upstream.body) return this.fail(response)
      void this.drain(upstream.body)
    } catch {
      this.fail(response)
    }
  }

  @Get('run/stream')
  async resumeCurrent(
    @Query('offset') offset: string | undefined,
    @Query('conversationId') conversationId: string | undefined,
    @Res() response: Response,
  ): Promise<void> {
    await this.stream(
      `/internal/agent/run/stream?offset=${encodeURIComponent(offset ?? '0')}&conversationId=${encodeURIComponent(conversationId ?? '')}`,
      response,
    )
  }

  @Get('run/:runId/stream')
  async resumeRun(
    @Param('runId') runId: string,
    @Query('offset') offset: string | undefined,
    @Res() response: Response,
  ): Promise<void> {
    await this.stream(
      `/internal/agent/run/${encodeURIComponent(runId)}/stream?offset=${encodeURIComponent(offset ?? '0')}`,
      response,
    )
  }

  private runtime(): string {
    return process.env.AGENT_RUNTIME_URL ?? 'http://127.0.0.1:9990'
  }

  private headers(clientId: string, input: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-main-client-id': clientId,
      'x-internal-token': process.env.AGENT_INTERNAL_TOKEN ?? '',
    }
    const userId = requestContext.get('userId')
    const adminId = requestContext.get('adminId')
    if (userId) headers['x-user-id'] = userId
    if (adminId) headers['x-admin-id'] = adminId
    if (input.authorization) headers.authorization = input.authorization
    if (input.cookie) headers.cookie = input.cookie
    return headers
  }

  private async callJson(path: string, body: unknown): Promise<unknown> {
    const upstream = await fetch(`${this.runtime()}${path}`, {
      method: 'POST',
      headers: this.headers(randomUUID(), {}),
      body: JSON.stringify(body ?? {}),
    })
    const payload = (await upstream.json().catch(() => ({}))) as unknown
    if (!upstream.ok) {
      throw new Error((payload as { message?: string })?.message ?? 'agent-runtime 调用失败')
    }
    // runtime 也套了响应信封；main 的信封拦截器会再包一层，这里先脱壳
    return (payload as { data?: unknown }).data ?? payload
  }

  private kafkaEnabled(): boolean {
    return Boolean(process.env.KAFKA_BROKERS?.trim())
  }

  /** Kafka 模式：attach 本地 clientId，runtime 的补发/实时 chunk 经 Kafka 回来 */
  private async stream(path: string, response: Response): Promise<void> {
    if (!this.kafkaEnabled()) return this.proxyStream(path, response)
    const clientId = randomUUID()
    // 先挂 session 但不发头部：runtime 可能马上推 Kafka；等确认有流再发 200，避免把 204 写成 200
    this.bridge.attach(clientId, response, true)
    const upstream = await fetch(`${this.runtime()}${path}`, {
      headers: this.headers(clientId, {}),
    }).catch(() => null)
    if (!upstream || upstream.status === 204 || !upstream.body) {
      this.bridge.detach(clientId)
      if (upstream?.status === 204) {
        response.status(204).end()
      } else {
        response.status(502).json({ message: 'agent-runtime 不可用' })
      }
      return
    }
    if (!upstream.ok) {
      this.bridge.detach(clientId)
      response.status(upstream.status).json({ message: 'agent-runtime 调用失败' })
      return
    }
    response.writeHead(200, SSE_HEADERS)
    response.flushHeaders()
    this.bridge.start(clientId)
    void this.drain(upstream.body)
  }

  /** 未配置 Kafka 时直接转发 runtime SSE */
  private async relay(
    path: string,
    method: 'POST',
    body: unknown,
    response: Response,
  ): Promise<void> {
    try {
      const upstream = await fetch(`${this.runtime()}${path}`, {
        method,
        headers: this.headers(randomUUID(), {}),
        body: JSON.stringify(body ?? {}),
      })
      if (!upstream.ok || !upstream.body) return this.fail(response)
      const reader = upstream.body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        response.write(Buffer.from(value))
      }
      response.end()
    } catch {
      this.fail(response)
    }
  }

  private async proxyStream(path: string, response: Response): Promise<void> {
    const upstream = await fetch(`${this.runtime()}${path}`, {
      headers: this.headers(randomUUID(), {}),
    })
    response.status(upstream.status)
    if (upstream.status === 204 || !upstream.body) {
      response.end()
      return
    }
    response.setHeader('content-type', 'text/event-stream')
    response.setHeader('cache-control', 'no-cache')
    response.setHeader('x-vercel-ai-ui-message-stream', 'v1')
    response.setHeader('x-accel-buffering', 'no')
    const reader = upstream.body.getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        response.write(Buffer.from(value))
      }
    } finally {
      response.end()
    }
  }

  private async drain(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader()
    try {
      for (;;) {
        const { done } = await reader.read()
        if (done) return
      }
    } catch {
      // Kafka 事件负责收尾
    }
  }

  private fail(response: Response): void {
    if (response.writableEnded) return
    response.write(
      `data: ${JSON.stringify({ type: 'error', errorText: 'agent-runtime 调用失败' })}\n\n`,
    )
    response.write('data: [DONE]\n\n')
    response.end()
  }
}
