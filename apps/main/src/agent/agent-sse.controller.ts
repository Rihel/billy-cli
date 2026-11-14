import { Body, Controller, Headers, HttpCode, Inject, Post, Res, UseGuards } from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import type { Response } from 'express'
import { AgentSseBridge } from './agent-sse.bridge.js'
import { AnyAuthGuard } from '../modules/auth/index.js'
import { requestContext } from '../common/index.js'

const SSE_HEADERS = {
  'content-type': 'text/event-stream',
  'cache-control': 'no-cache',
  connection: 'keep-alive',
  'x-vercel-ai-ui-message-stream': 'v1',
  'x-accel-buffering': 'no',
}

/** 前端唯一入口：main 起流，runtime 跑 agent，输出经 Kafka 回到这里 */
@Controller('agent')
@UseGuards(AnyAuthGuard)
export class AgentSseController {
  constructor(@Inject(AgentSseBridge) private readonly bridge: AgentSseBridge) {}

  @Post('chat/stream')
  @HttpCode(200)
  async chatStream(
    @Body() body: unknown,
    @Headers('authorization') authorization: string | undefined,
    @Headers('cookie') cookie: string | undefined,
    @Res() response: Response,
    @Headers() headers: Record<string, string>,
  ): Promise<void> {
    const clientId = randomUUID()
    const runtime = process.env.AGENT_RUNTIME_URL ?? 'http://127.0.0.1:9990'
    const kafkaEnabled = Boolean(process.env.KAFKA_BROKERS?.trim())

    response.writeHead(200, SSE_HEADERS)
    response.flushHeaders()
    if (!kafkaEnabled) {
      await this.relayDirect(runtime, body, headers, response)
      return
    }
    this.bridge.attach(clientId, response)

    const requestHeaders = this.headers(clientId, headers)
    requestHeaders['content-type'] = 'application/json'

    try {
      const upstream = await fetch(`${runtime}/internal/agent/chat/stream`, {
        method: 'POST',
        headers: requestHeaders,
        body: JSON.stringify(body ?? {}),
      })
      if (!upstream.ok || !upstream.body) {
        response.write(
          `data: ${JSON.stringify({ type: 'error', errorText: 'agent-runtime 启动失败' })}\n\n`,
        )
        response.write('data: [DONE]\n\n')
        response.end()
        return
      }
      // runtime 的 SSE 体只用来维持运行；内容以 Kafka 为准，这里必须持续读掉背压。
      void this.drain(upstream.body)
    } catch {
      if (!response.writableEnded) {
        response.write(
          `data: ${JSON.stringify({ type: 'error', errorText: 'agent-runtime 不可用' })}\n\n`,
        )
        response.write('data: [DONE]\n\n')
        response.end()
      }
    }
  }

  private headers(clientId: string, input: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = {
      'x-main-client-id': clientId,
      'x-internal-token': process.env.AGENT_INTERNAL_TOKEN ?? '',
    }
    const userId = requestContext.get('userId')
    const adminId = requestContext.get('adminId')
    if (userId) headers['x-user-id'] = userId
    if (adminId) headers['x-admin-id'] = adminId
    if (input.authorization) headers.authorization = input.authorization
    if (input.cookie) headers.cookie = input.cookie
    if (input['x-request-id']) headers['x-request-id'] = input['x-request-id']
    return headers
  }

  /** 未配置 Kafka 的降级：直接转发 runtime 的 SSE（单机/开发） */
  private async relayDirect(
    runtime: string,
    body: unknown,
    headers: Record<string, string>,
    response: Response,
  ): Promise<void> {
    const requestHeaders = this.headers(randomUUID(), headers)
    requestHeaders['content-type'] = 'application/json'
    try {
      const upstream = await fetch(`${runtime}/internal/agent/chat/stream`, {
        method: 'POST',
        headers: requestHeaders,
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

  private fail(response: Response): void {
    if (response.writableEnded) return
    response.write(
      `data: ${JSON.stringify({ type: 'error', errorText: 'agent-runtime 调用失败' })}\n\n`,
    )
    response.write('data: [DONE]\n\n')
    response.end()
  }

  private async drain(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader()
    try {
      for (;;) {
        const { done } = await reader.read()
        if (done) return
      }
    } catch {
      // 前端断开 / runtime 结束都正常；Kafka 事件负责收尾
    }
  }
}
