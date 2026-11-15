import { Body, Controller, Headers, HttpCode, Inject, Post, Res, UseGuards } from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import type { Response } from 'express'
import { AgentSseBridge } from './agent-sse.bridge.js'
import { AnyAuthGuard } from '../modules/auth/index.js'
import { RateLimit, RateLimitGuard } from '../common/security/index.js'
import { requestContext } from '@repo/kits'

const SSE_HEADERS = {
  'content-type': 'text/event-stream',
  'cache-control': 'no-cache',
  connection: 'keep-alive',
  'x-vercel-ai-ui-message-stream': 'v1',
  'x-accel-buffering': 'no',
}

/** 前端唯一入口：main 起流，runtime 跑 agent，输出经 pub/sub 回到这里 */
@Controller('agent')
@UseGuards(AnyAuthGuard)
export class AgentSseController {
  constructor(@Inject(AgentSseBridge) private readonly bridge: AgentSseBridge) {}

  @Post('chat/stream')
  @HttpCode(200)
  @UseGuards(RateLimitGuard)
  @RateLimit({ scope: 'agent-chat', limit: 10, windowSeconds: 60, identity: 'user' })
  async chatStream(
    @Body() body: unknown,
    @Headers('authorization') authorization: string | undefined,
    @Headers('cookie') cookie: string | undefined,
    @Res() response: Response,
    @Headers() headers: Record<string, string>,
  ): Promise<void> {
    const clientId = randomUUID()
    const runtime = process.env.AGENT_RUNTIME_URL ?? 'http://127.0.0.1:9990'

    response.writeHead(200, SSE_HEADERS)
    response.flushHeaders()
    // 先挂订阅再触发运行：runtime 一旦开跑就会往这条频道发帧，晚一步首帧就丢了
    await this.bridge.attach(clientId, response)

    const requestHeaders = this.headers(clientId, headers)
    requestHeaders['content-type'] = 'application/json'

    try {
      const upstream = await fetch(`${runtime}/internal/agent/chat/stream`, {
        method: 'POST',
        headers: requestHeaders,
        body: JSON.stringify(body ?? {}),
      })
      if (!upstream.ok || !upstream.body) {
        this.bridge.detach(clientId)
        this.fail(response, 'agent-runtime 启动失败')
        return
      }
      // runtime 的 SSE 体只用来维持运行；内容以 pub/sub 为准，这里必须持续读掉背压。
      void this.drain(upstream.body)
    } catch {
      this.bridge.detach(clientId)
      this.fail(response, 'agent-runtime 不可用')
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

  private fail(response: Response, errorText: string): void {
    if (response.writableEnded) return
    response.write(`data: ${JSON.stringify({ type: 'error', errorText })}\n\n`)
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
      // 前端断开 / runtime 结束都正常；pub/sub 的 final 帧负责收尾
    }
  }
}
