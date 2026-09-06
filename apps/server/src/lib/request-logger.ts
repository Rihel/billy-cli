import { nanoid } from '@repo/shared';
import { createLogger } from '@repo/shared/logger';
import type { Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import { mapError } from './http.js';
import { requestContext } from './request-context.js';

const logger = createLogger('request', true, process.env.LOG_LEVEL ?? 'info');

const getClientIp = (context: Context) =>
  context.req.header('x-forwarded-for')?.split(',')[0]?.trim() || '-';

/**
 * 请求日志中间件：
 * - 为每个请求生成 requestId，并写入响应头 `X-Request-Id`
 * - debug 级别记录请求开始（method / path / query / ip / user-agent）
 * - 按状态码分级记录请求完成（<400 info，4xx warn，5xx error），
 *   附带耗时、userId、ip、user-agent 等上下文
 * - 路由抛错时记录错误后继续向上抛出，交给全局 onError 处理
 */
export const requestLogger = createMiddleware(async (context, next) => {
  const requestId = nanoid(16);
  const startedAt = performance.now();
  const method = context.req.method;
  const path = context.req.path;
  const query = context.req.query();
  const hasQuery = Object.keys(query).length > 0;
  const ip = getClientIp(context);
  const userAgent = context.req.header('user-agent') || '-';

  context.header('X-Request-Id', requestId);

  logger.debug('request start', {
    requestId,
    method,
    path,
    ...(hasQuery ? { query } : {}),
    ip,
    // userAgent,
  });

  try {
    await next();
  } catch (error) {
    const status = mapError(error).http;
    const durationMs = Math.round(performance.now() - startedAt);
    logger.error(`${method} ${path} -> ${status} ${durationMs}ms`, {
      requestId,
      userId: requestContext.get('userId') ?? null,
      ip,
      userAgent,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }

  const status = context.res.status;
  const durationMs = Math.round(performance.now() - startedAt);
  const common = {
    requestId,
    userId: requestContext.get('userId') ?? null,
    ip,
    // userAgent,
  };
  const message = `${method} ${path} -> ${status} ${durationMs}ms`;

  if (status >= 500) {
    logger.error(message, common);
  } else if (status >= 400) {
    logger.warn(message, common);
  } else {
    logger.info(message, common);
  }
});
