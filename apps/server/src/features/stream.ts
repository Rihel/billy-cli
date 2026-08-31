import { StreamHub } from '@repo/kits';
import { StreamSubscribeSchema } from '@repo/shared';
import type { AppContext } from '@repo/di';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { makeRequireAdminAuth, makeRequireAuth } from '../lib/authentication.js';
import { jsonBody } from '../lib/http.js';
import { requestContext } from '../lib/request-context.js';

export interface SseRouteOptions {
  /** 鉴权身份：'user'（前台用户，默认）| 'admin'（后台管理员） */
  auth?: 'user' | 'admin';
  /**
   * 业务频道白名单校验（如 task:42 / notification:all 等）。
   * 默认仅允许身份频道（user:* / admin:* 前缀由服务端强制替换为当前身份，业务频道一律拒绝）；
   * 业务方需要订阅自定义频道时在此注入校验（如数据库 / 缓存核对归属权）。
   */
  allowChannel?: (channel: string) => boolean;
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
  const result = new Set<string>();
  for (const channel of requested) {
    if (channel.startsWith('user:') || channel.startsWith('admin:')) continue;
    if (allowChannel(channel)) result.add(channel);
  }
  return [...result];
};

/**
 * SSE 服务端路由：`POST /sse/subscribe`（Bearer / cookie 认证），
 * body `{ channels: ['task:42'] }` → 长连接推流。
 *
 * 用法：
 *   const sseHub = runtime.get(StreamHub);
 *   sseHub.publish('task:42', { event: 'progress', data: { percent: 50 } });
 */
export const makeStreamRoutes = (
  runtime: AppContext,
  options: SseRouteOptions = {},
) => {
  const { auth = 'user', allowChannel = () => false } = options;
  const hub = runtime.get(StreamHub);
  const requireAuth =
    auth === 'admin' ? makeRequireAdminAuth(runtime) : makeRequireAuth(runtime);

  const routes = new Hono();
  routes.use('/subscribe', requireAuth);

  routes.post('/subscribe', jsonBody(StreamSubscribeSchema), (context) => {
    const { channels } = context.req.valid('json');
    const identityChannel =
      auth === 'admin'
        ? `admin:${requestContext.get('adminId')}`
        : `user:${requestContext.get('userId')}`;

    return streamSSE(context, async (stream) => {
      // 长连接：挂起直到客户端断开（abort 信号 → conn.close → closed resolve）
      const connection = hub.createConnection({
        writer: (frame) => stream.writeSSE(frame),
        rawWriter: async (chunk) => {
          await stream.write(chunk)
        },
        signal: context.req.raw.signal,
      });
      // 强制注册身份频道 + 白名单业务频道
      hub.subscribe(connection, identityChannel);
      for (const channel of resolveChannels(channels, allowChannel)) {
        hub.subscribe(connection, channel);
      }
      await connection.closed;
    });
  });

  return routes;
};
