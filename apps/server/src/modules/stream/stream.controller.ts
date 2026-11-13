import { Body, Controller, HttpCode, Inject, Post, Req, Res, UseGuards } from '@nestjs/common'
import { StreamHub, type StreamFrame } from '@repo/kits'
import { StreamSubscribeSchema } from '@repo/shared'
import type { StreamSubscribeDto } from '@repo/shared'
import type { Request, Response } from 'express'
import { requestContext } from '../../common/index.js'
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
 * 解析本次连接实际订阅的频道（身份频道 / 广播频道 / 业务频道三类）：
 *
 * 1. **身份频道**（`user:{userId}` / `admin:{adminId}`）：由服务端按当前身份强制注册，客户端指定无效；
 * 2. **广播频道**（`options.broadcastChannels`）：只放行与当前身份**同域**的项（管理员只拿
 *    `admin:` 前缀、用户只拿 `user:` 前缀），跨域静默忽略 —— 否则前台用户就能收到管理员广播；
 * 3. **业务频道**：走 `allowChannel` 白名单（默认全拒）；
 * 4. **派生频道**：由 `options.derivedChannels(identity)` 按当前身份算出（如 AI 的 `ai:owner:{id}`）。
 *
 * `auth: 'both'` 按实际通过的身份订阅；鉴权关闭（`AUTH_ENABLED=false`，无任何身份）时
 * 仅订阅广播频道 —— 该模式下守卫本就全放行、应用完全开放，这里与整体姿态一致。
 */
const resolveSubscriptions = (
  requested: string[],
  options: Required<SseRouteOptions>,
  identity: { userId?: string; adminId?: string },
): string[] => {
  const result = new Set<string>()

  const subscribeDomain = (domain: 'user' | 'admin') => {
    const id = domain === 'admin' ? identity.adminId : identity.userId
    if (id) result.add(`${domain}:${id}`)
    for (const channel of options.broadcastChannels) {
      if (channel.startsWith(`${domain}:`)) result.add(channel)
    }
  }

  if (options.auth === 'admin') subscribeDomain('admin')
  else if (options.auth === 'user') subscribeDomain('user')
  else {
    if (identity.userId) subscribeDomain('user')
    if (identity.adminId) subscribeDomain('admin')
    if (!identity.userId && !identity.adminId) {
      for (const channel of options.broadcastChannels) result.add(channel)
    }
  }

  for (const channel of resolveChannels(requested, options.allowChannel)) {
    result.add(channel)
  }

  // 4. 派发频道：由鉴权身份算出（客户端不传），因此不需要归属校验
  for (const channel of options.derivedChannels(identity)) {
    result.add(channel)
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
    // 身份直接读 ALS（**不要**用 currentUserId / currentAdminId：它们在身份缺失时抛错，
    // 而 'both' 模式下必然有一个缺失 —— 管理员连接没有 userId、用户连接没有 adminId）
    const channels = resolveSubscriptions(input.channels, this.options, {
      userId: requestContext.get('userId') ?? undefined,
      adminId: requestContext.get('adminId') ?? undefined,
    })

    // SSE 响应头
    response.writeHead(200, {
      'Transfer-Encoding': 'chunked',
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    })
    // 立即把响应头发出去：否则 Node 会等第一次 write 才 flush，而长连接的下一次写可能是
    // 15s 后的心跳 —— 客户端 fetch 迟迟不 resolve，连接状态一直停在 connecting（表现为
    // 「已连上却显示连接中」，且前置网关的空闲超时可能先把它掐掉）。
    response.flushHeaders()

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

    // 身份频道（服务端强制）+ 同域广播频道 + 白名单业务频道
    for (const channel of channels) {
      this.hub.subscribe(connection, channel)
    }

    // 长连接：挂起直到客户端断开（abort → conn.close → closed resolve）
    await connection.closed
    if (!response.writableEnded) response.end()
  }
}
