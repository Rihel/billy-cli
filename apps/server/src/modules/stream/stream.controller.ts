import {
  Body,
  Controller,
  HttpCode,
  Inject,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common'
import { StreamHub, type StreamFrame } from '@repo/kits'
import { StreamSubscribeSchema } from '@repo/shared'
import type { StreamSubscribeDto } from '@repo/shared'
import type { Request, Response } from 'express'
import { currentAdminId, currentUserId } from '../../common/index.js'
import { StreamAuthGuard } from './stream-auth.guard.js'
import { SSE_ROUTE_OPTIONS, type SseRouteOptions } from './stream.options.js'

/**
 * 写 SSE 帧（WHATWG SSE 帧格式：event → data → id，data 支持多行，空行结束）：
 * 字段顺序 event → data → id，data 支持多行（每行前缀 `data: `），帧以空行结束。
 */
const writeSseFrame = (response: Response, frame: StreamFrame): void => {
  const dataLines = frame.data
    .split(/\r\n|\r|\n/)
    .map((line) => `data: ${line}`)
    .join('\n')
  const payload = [
    frame.event ? `event: ${frame.event}` : undefined,
    dataLines,
    frame.id !== undefined ? `id: ${frame.id}` : undefined,
  ]
    .filter(Boolean)
    .join('\n')
  response.write(`${payload}\n\n`)
}

/**
 * 解析客户端请求的订阅频道：
 * - `user:*` / `admin:*` 前缀一律忽略（防窃听他人身份频道，身份频道由服务端强制注册）；
 * - 业务频道按 allowChannel 白名单校验，不通过则忽略。
 */
const resolveChannels = (
  requested: string[],
  allowChannel: (channel: string) => boolean,
): string[] => {
  const result = new Set<string>()
  for (const channel of requested) {
    if (channel.startsWith('user:') || channel.startsWith('admin:')) continue
    if (allowChannel(channel)) result.add(channel)
  }
  return [...result]
}

/**
 * SSE 服务端推流路由：`POST /sse/subscribe`（Bearer / cookie 认证），
 * body `{ channels: ['task:42'] }` → 长连接推流（HTTP 长连接由 kits StreamHub 管理）。
 *
 * 用法（业务侧发布）：
 *   streamHub.publish('task:42', { event: 'progress', data: { percent: 50 } })
 *
 * 实现说明：SSE 用 `@Res()` 自行写原始响应（Nest 的 `@Sse()` 只支持 GET），
 * 因此该路由返回 undefined、不经过响应信封拦截器；HTTP 200 由 writeHead 显式设置。
 */
@Controller('sse')
export class StreamController {
  constructor(
    @Inject(StreamHub) private readonly hub: StreamHub,
    @Inject(SSE_ROUTE_OPTIONS) private readonly options: Required<SseRouteOptions>,
  ) {}

  @Post('subscribe')
  @HttpCode(200)
  @UseGuards(StreamAuthGuard)
  async subscribe(
    @Body({ schema: StreamSubscribeSchema }) input: StreamSubscribeDto,
    @Res() response: Response,
    @Req() request: Request,
  ): Promise<void> {
    const identityChannel =
      this.options.auth === 'admin'
        ? `admin:${currentAdminId()}`
        : `user:${currentUserId()}`

    // SSE 响应头
    response.writeHead(200, {
      'Transfer-Encoding': 'chunked',
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    })

    // 客户端断开（Express 'close'）→ abort → StreamConnection.close → closed resolve
    const abort = new AbortController()
    request.on('close', () => abort.abort())

    const connection = this.hub.createConnection({
      writer: async (frame) => writeSseFrame(response, frame),
      rawWriter: async (chunk) => {
        response.write(chunk)
      },
      signal: abort.signal,
    })

    // 强制注册身份频道 + 白名单业务频道
    this.hub.subscribe(connection, identityChannel)
    for (const channel of resolveChannels(input.channels, this.options.allowChannel)) {
      this.hub.subscribe(connection, channel)
    }

    // 长连接：挂起直到客户端断开（abort → conn.close → closed resolve）
    await connection.closed
    if (!response.writableEnded) response.end()
  }
}
