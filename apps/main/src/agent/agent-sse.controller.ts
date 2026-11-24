import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Inject,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import type { Response } from 'express'
import { AgentSseBridge, parseStreamProtocol } from './agent-sse.bridge.js'
import { AgentRuntimeGateway } from './agent-runtime.gateway.js'
import { drainStream } from './stream-drain.js'
import { AnyAuthGuard } from '../modules/auth/index.js'
import { RateLimit, RateLimitGuard } from '../common/security/index.js'

const SSE_HEADERS = {
  'content-type': 'text/event-stream',
  'cache-control': 'no-cache',
  connection: 'keep-alive',
  'x-accel-buffering': 'no',
}

/**
 * 前端唯一入口：main 起流，runtime 跑 agent，输出经 pub/sub 回到这里。
 *
 * 上游调用走 `AgentRuntimeGateway`（SDK）：这里只做「先挂订阅、再让 runtime 开跑」的顺序，
 * 以及把上游响应体持续读掉（背压）。
 */
@Controller('agent')
@UseGuards(AnyAuthGuard)
export class AgentSseController {
  constructor(
    @Inject(AgentSseBridge) private readonly bridge: AgentSseBridge,
    @Inject(AgentRuntimeGateway) private readonly runtime: AgentRuntimeGateway,
  ) {}

  @Post('chat/stream')
  @HttpCode(200)
  @UseGuards(RateLimitGuard)
  @RateLimit({ scope: 'agent-chat', limit: 10, windowSeconds: 60, identity: 'user' })
  async chatStream(
    @Body() body: unknown,
    @Headers() headers: Record<string, string>,
    @Res() response: Response,
    @Query('protocol') protocol: string | undefined,
  ): Promise<void> {
    const clientId = randomUUID()
    response.writeHead(200, SSE_HEADERS)
    response.flushHeaders()
    // 先挂订阅再触发运行：runtime 一旦开跑就会往这条频道发帧，晚一步首帧就丢了。
    // 订阅失败绝不能"照常起跑"：那一轮所有帧都会发到没人收的频道。
    const attached = await this.bridge.attach(clientId, response, {
      protocol: parseStreamProtocol(protocol),
    })
    if (!attached) {
      this.bridge.fail(clientId, '实时通道订阅失败，请重试')
      return
    }

    let upstream
    try {
      upstream = await this.runtime.openStream('/internal/agent/chat/stream', {
        method: 'POST',
        body: body ?? {},
        // 调用方凭据要透传给 runtime（它据此校验运行归属）；身份头由 gateway 补
        headers: {
          'x-main-client-id': clientId,
          'x-request-id': headers['x-request-id'],
          authorization: headers.authorization,
          cookie: headers.cookie,
        },
      })
    } catch {
      this.bridge.fail(clientId, 'agent-runtime 不可用')
      return
    }
    if (!upstream.body || upstream.status >= 400) {
      this.bridge.fail(clientId, 'agent-runtime 启动失败')
      return
    }
    // runtime 的 SSE 体只用来维持运行；内容以 pub/sub 为准，这里必须持续读掉背压。
    void drainStream(upstream.body)
  }
}
