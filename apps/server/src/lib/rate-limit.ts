import { RateLimiter, isIpWhitelisted, normalizeIp } from '@repo/kits';
import type { AppContext } from '@repo/di';
import { AppErrorCodes, ResponseUtils } from '@repo/shared';
import { getConnInfo } from '@hono/node-server/conninfo';
import { createMiddleware } from 'hono/factory';
import type { Context } from 'hono';
import { ServerConfig, type ServerConfig as ServerConfigType } from '../config.js';
import { describeErrorCode } from './http.js';

export interface RateLimitOptions {
  /** 限流标识（key 前缀），如 'login' / 'admin-login' / 'forgot-password' */
  scope: string;
  /** 窗口内最大请求数，默认 20 */
  limit?: number;
  /** 窗口秒数，默认 60 */
  windowSeconds?: number;
  /**
   * 豁免白名单（精确 IP / IPv4 CIDR）；缺省读 ServerConfig.rateLimitWhitelist
   * （env `RATE_LIMIT_WHITELIST`）。命中白名单跳过限流。
   */
  whitelist?: string[];
}

/** 提取客户端 IP：trustProxy 时取 x-forwarded-for 首值，否则直连 socket 地址；统一规范化。 */
export const clientIp = (context: Context, trustProxy: boolean): string => {
  if (trustProxy) {
    const forwarded = context.req.header('x-forwarded-for');
    if (forwarded) {
      const first = forwarded.split(',')[0].trim();
      if (first) return normalizeIp(first);
    }
  }
  try {
    const info = getConnInfo(context);
    return normalizeIp(info.remote.address ?? 'unknown');
  } catch {
    return 'unknown';
  }
};

const tooManyRequests = (context: Context, retryAfterSeconds: number) => {
  const error = describeErrorCode(AppErrorCodes.RateLimited);
  context.header('Retry-After', String(retryAfterSeconds));
  return context.json(
    ResponseUtils.error(error.value, error.label),
    error.http,
  );
};

/**
 * 限流中间件：按 IP 固定窗口计数（kits RateLimiter + RedisStore），
 * 超限返回 429 + Retry-After；白名单 IP 豁免。
 *
 * 用法：
 *   routes.post('/login',
 *     makeRateLimit(runtime, { scope: 'login' }),
 *     jsonBody(LoginSchema), async (context) => ...)
 */
export const makeRateLimit = (runtime: AppContext, options: RateLimitOptions) =>
  createMiddleware(async (context, next) => {
    const config = runtime.get<ServerConfigType>(ServerConfig);
    const whitelist = options.whitelist ?? config.rateLimitWhitelist;
    const ip = clientIp(context, config.rateLimitTrustProxy);

    if (isIpWhitelisted(ip, whitelist)) {
      return next();
    }

    const decision = await runtime.get(RateLimiter).check(
      `${options.scope}:${ip}`,
      options.limit ?? 20,
      options.windowSeconds ?? 60,
    );
    if (!decision.allowed) {
      return tooManyRequests(context, decision.retryAfterSeconds);
    }
    await next();
  });
