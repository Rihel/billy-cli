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
import { AgentSseBridge, parseStreamProtocol } from './agent-sse.bridge.js'
import { AgentRunStopSchema, type AgentRunStopDto } from '@repo/shared'

const SSE_HEADERS = {
  'content-type': 'text/event-stream',
  'cache-control': 'no-cache',
  connection: 'keep-alive',
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
  stop(@Body({ schema: AgentRunStopSchema }) body: AgentRunStopDto) {
    return this.callJson('/internal/agent/run/stop', body)
  }

  @Post('chat/resume')
  @HttpCode(200)
  async resume(
    @Body() body: unknown,
    @Headers() headers: Record<string, string>,
    @Res() response: Response,
    @Query('protocol') protocol: string | undefined,
  ): Promise<void> {
    const clientId = randomUUID()
    const streamProtocol = parseStreamProtocol(protocol)
    response.writeHead(200, SSE_HEADERS)
    response.flushHeaders()
    const attached = await this.bridge.attach(clientId, response, { protocol: streamProtocol })
    if (!attached) {
      this.bridge.fail(clientId, '实时通道订阅失败，请重试')
      return
    }
    try {
      const upstream = await fetch(`${this.runtime()}/internal/agent/chat/resume`, {
        method: 'POST',
        headers: this.headers(clientId, headers),
        body: JSON.stringify(body ?? {}),
      })
      if (!upstream.ok || !upstream.body) {
        this.bridge.fail(clientId, 'agent-runtime 调用失败')
        return
      }
      void this.drain(upstream.body)
    } catch {
      this.bridge.fail(clientId, 'agent-runtime 不可用')
    }
  }

  @Get('run/stream')
  async resumeCurrent(
    @Query('sinceRev') sinceRev: string | undefined,
    @Query('conversationId') conversationId: string | undefined,
    @Query('protocol') protocol: string | undefined,
    @Res() response: Response,
  ): Promise<void> {
    await this.stream(
      `/internal/agent/run/stream?sinceRev=${encodeURIComponent(sinceRev ?? '')}&conversationId=${encodeURIComponent(conversationId ?? '')}`,
      response,
      parseStreamProtocol(protocol),
    )
  }

  /** 当前进行中那一轮的快照（没有就 204，前端据此不要点亮"恢复中"） */
  @Get('run/snapshot')
  async snapshotCurrent(
    @Query('conversationId') conversationId: string | undefined,
    @Res() response: Response,
  ): Promise<void> {
    await this.proxySnapshot(
      `/internal/agent/run/snapshot?conversationId=${encodeURIComponent(conversationId ?? '')}`,
      response,
    )
  }

  @Get('run/:runId/stream')
  async resumeRun(
    @Param('runId') runId: string,
    @Query('sinceRev') sinceRev: string | undefined,
    @Query('protocol') protocol: string | undefined,
    @Res() response: Response,
  ): Promise<void> {
    await this.stream(
      `/internal/agent/run/${encodeURIComponent(runId)}/stream?sinceRev=${encodeURIComponent(sinceRev ?? '')}`,
      response,
      parseStreamProtocol(protocol),
    )
  }

  /** 指定 run 的快照（知道 runId 时用） */
  @Get('run/:runId/snapshot')
  async snapshotRun(@Param('runId') runId: string, @Res() response: Response): Promise<void> {
    await this.proxySnapshot(`/internal/agent/run/${encodeURIComponent(runId)}/snapshot`, response)
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

  /**
   * 断线重连：先挂上 `clientId` 的 pub/sub 订阅，再让 runtime 从 Redis 输出记录按 offset 补发。
   *
   * 补发帧与后续实时帧走同一条定向频道，main 只负责按序写给前端。
   */
  private async stream(path: string, response: Response, protocol: 'agui' | 'ai'): Promise<void> {
    const clientId = randomUUID()
    // 先挂 session 但不发头部：runtime 可能马上推帧；等确认有流再发 200，避免把 204 写成 200
    const attached = await this.bridge.attach(clientId, response, { deferred: true, protocol })
    if (!attached) {
      this.bridge.detach(clientId)
      response.status(503).json({ message: '实时通道订阅失败，请重试' })
      return
    }
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

  private async drain(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader()
    try {
      for (;;) {
        const { done } = await reader.read()
        if (done) return
      }
    } catch {
      // pub/sub 的 final 帧负责收尾
    }
  }

  /** 快照代理：runtime 的 204 原样透传，JSON 原样回给前端 */
  private async proxySnapshot(path: string, response: Response): Promise<void> {
    const upstream = await fetch(`${this.runtime()}${path}`, {
      headers: this.headers(randomUUID(), {}),
    }).catch(() => null)
    if (!upstream) {
      response.status(502).json({ message: 'agent-runtime 不可用' })
      return
    }
    if (upstream.status === 204) {
      // 统一套 AppResponse 信封：SDK 的 `HttpClient.get` 才能复用鉴权 / 401 刷新 / 错误归一
      response.json({ code: 0, data: null })
      return
    }
    const body = await upstream.text().catch(() => '')
    if (!upstream.ok) {
      response.status(upstream.status).json({ message: 'agent-runtime 调用失败' })
      return
    }
    // 200 但空 body（中间层截断 / 代理异常）不能让 `JSON.parse('')` 抛成 500：
    // 快照拿不到就按"本次没有快照"处理（前端拿到 null 不会点亮恢复灯）。
    let data: unknown = null
    if (body) {
      try {
        data = JSON.parse(body) as unknown
      } catch {
        data = null
      }
    }
    response.json({ code: 0, data })
  }
}
