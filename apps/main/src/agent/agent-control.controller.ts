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
import { InternalApiError } from '@repo/internal-sdk'
import { AgentChatSchema, AgentRunStopSchema } from '@repo/shared'
import type { AgentChatDto, AgentRunStopDto } from '@repo/shared'
import { AnyAuthGuard } from '../modules/auth/index.js'
import { RateLimit, RateLimitGuard } from '../common/security/index.js'
import { AgentSseBridge, parseStreamProtocol } from './agent-sse.bridge.js'
import { AgentRuntimeGateway } from './agent-runtime.gateway.js'
import { drainStream } from './stream-drain.js'

const SSE_HEADERS = {
  'content-type': 'text/event-stream',
  'cache-control': 'no-cache',
  connection: 'keep-alive',
  'x-accel-buffering': 'no',
}

/**
 * 会话控制：停止 / 回答问题续跑 / 断线重连；全部由 main 鉴权后转内部接口。
 *
 * 内部调用统一走 `AgentRuntimeGateway`（SDK）：令牌 / 超时 / 身份头只有一份实现；
 * 这里只负责 HTTP 边界与 SSE 头、状态码的转换。
 */
@Controller('agent')
@UseGuards(AnyAuthGuard)
export class AgentControlController {
  constructor(
    @Inject(AgentSseBridge) private readonly bridge: AgentSseBridge,
    @Inject(AgentRuntimeGateway) private readonly runtime: AgentRuntimeGateway,
  ) {}

  @Post('chat')
  @HttpCode(200)
  @UseGuards(RateLimitGuard)
  @RateLimit({ scope: 'agent-chat', limit: 10, windowSeconds: 60, identity: 'user' })
  chat(@Body({ schema: AgentChatSchema }) body: AgentChatDto) {
    return this.runtime.chat(body)
  }

  @Post('run/stop')
  @HttpCode(200)
  stop(@Body({ schema: AgentRunStopSchema }) body: AgentRunStopDto) {
    return this.runtime.stopRun(body)
  }

  @Post('chat/resume')
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
    let upstream
    try {
      upstream = await this.runtime.openStream('/internal/agent/chat/resume', {
        method: 'POST',
        body: body ?? {},
        headers: this.forwardedHeaders(clientId, headers),
      })
    } catch {
      this.bridge.fail(clientId, 'agent-runtime 不可用')
      return
    }
    if (upstream.status >= 400 || !upstream.body) {
      this.bridge.fail(clientId, 'agent-runtime 调用失败')
      return
    }
    void drainStream(upstream.body)
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
    await this.proxySnapshot(() => this.runtime.snapshotCurrentRun(conversationId), response)
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
    await this.proxySnapshot(() => this.runtime.snapshotRun(runId), response)
  }

  /**
   * SSE 透传要转发给执行面的头：本次中转的 clientId + 调用方凭据 + 请求 id。
   *
   * 身份头（`x-user-id` / `x-admin-id`）不在这里拼：由 `AgentRuntimeGateway` 统一从
   * 请求上下文补齐，避免两份实现漂移（早先 control 侧漏转 `x-request-id`）。
   */
  private forwardedHeaders(
    clientId: string,
    headers: Record<string, string>,
  ): Record<string, string | undefined> {
    return {
      'x-main-client-id': clientId,
      'x-request-id': headers['x-request-id'],
      authorization: headers.authorization,
      cookie: headers.cookie,
    }
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
    let upstream
    try {
      upstream = await this.runtime.openStream(path, {
        headers: { 'x-main-client-id': clientId },
      })
    } catch {
      this.bridge.detach(clientId)
      response.status(502).json({ message: 'agent-runtime 不可用' })
      return
    }
    if (upstream.status === 204) {
      this.bridge.detach(clientId)
      response.status(204).end()
      return
    }
    if (!upstream.body) {
      this.bridge.detach(clientId)
      response.status(502).json({ message: 'agent-runtime 不可用' })
      return
    }
    if (upstream.status < 200 || upstream.status >= 300) {
      this.bridge.detach(clientId)
      response.status(upstream.status).json({ message: 'agent-runtime 调用失败' })
      return
    }
    response.writeHead(200, SSE_HEADERS)
    response.flushHeaders()
    this.bridge.start(clientId)
    void drainStream(upstream.body)
  }

  /**
   * 快照代理：runtime 的 204（没有进行中的流）与空 / 残缺 body 都归成 `data: null`，
   * 前端拿到 null 不会点亮恢复灯；运行异常按上游状态透传。
   */
  private async proxySnapshot(load: () => Promise<unknown>, response: Response): Promise<void> {
    try {
      response.json({ code: 0, data: await load() })
    } catch (error) {
      if (error instanceof InternalApiError) {
        response.status(error.status).json({ message: 'agent-runtime 调用失败' })
        return
      }
      response.status(502).json({ message: 'agent-runtime 不可用' })
    }
  }
}
