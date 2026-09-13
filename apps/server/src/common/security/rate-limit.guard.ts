import {
  Inject,
  Injectable,
  SetMetadata,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { RateLimiter, isIpWhitelisted, normalizeIp } from '@repo/kits'
import { AppErrorCodes } from '@repo/shared'
import type { Request } from 'express'
import { resolveServerConfig, type ServerConfig } from '../../config.js'
import { BoundaryError } from '../error/boundary-error.js'
import { describeErrorCode } from '../error/error-descriptor.js'

export interface RateLimitOptions {
  /** 限流标识（key 前缀），如 'login' / 'admin-login' / 'forgot-password' */
  scope: string
  /** 窗口内最大请求数，默认 20 */
  limit?: number
  /** 窗口秒数，默认 60 */
  windowSeconds?: number
  /**
   * 豁免白名单（精确 IP / IPv4 CIDR）；缺省读 ServerConfig.rateLimitWhitelist
   * （env `RATE_LIMIT_WHITELIST`）。命中白名单跳过限流。
   */
  whitelist?: string[]
}

const RATE_LIMIT_METADATA = Symbol.for('RateLimitOptions')

/** 方法装饰器：声明该路由的限流策略，配合 `@UseGuards(RateLimitGuard)` 使用 */
export const RateLimit = (options: RateLimitOptions): MethodDecorator =>
  SetMetadata(RATE_LIMIT_METADATA, options)

/**
 * 提取客户端 IP：trustProxy 时取 x-forwarded-for 首值，否则直连 socket 地址；统一规范化。
 * 注意：不可用 Express 的 req.ip（其取值受 trust proxy 设置影响，且未做 IPv6 归一化）。
 */
export const clientIp = (request: Request, trustProxy: boolean): string => {
  if (trustProxy) {
    const forwarded = request.headers['x-forwarded-for']
    const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded
    const first = raw?.split(',')[0]?.trim()
    if (first) return normalizeIp(first)
  }
  return normalizeIp(request.socket.remoteAddress ?? 'unknown')
}

/**
 * 限流守卫：按 IP 固定窗口计数（kits RateLimiter + RedisStore），
 * 超限抛 429 边界错误（带 Retry-After 响应头）；白名单 IP 豁免。
 *
 * 用 `Reflect.getMetadata` 直接读方法元数据而非注入 `Reflector`：本项目 dev 走 tsx（esbuild），
 * 不产出 design:paramtypes，全部依赖必须显式 `@Inject`，故避免额外注入器依赖。
 *
 * 用法：
 *   @Post('login')
 *   @HttpCode(200)
 *   @UseGuards(RateLimitGuard)
 *   @RateLimit({ scope: 'login' })
 *   login(@Body({ schema: LoginSchema }) input: LoginDto) { ... }
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  /** 应用级业务配置（bootstrap 前已加载校验，构造期解析一次即可） */
  private readonly server: ServerConfig

  constructor(
    @Inject(RateLimiter) private readonly rateLimiter: RateLimiter,
    @Inject(ConfigService) config: ConfigService,
  ) {
    this.server = resolveServerConfig(config)
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const options: RateLimitOptions | undefined = Reflect.getMetadata(
      RATE_LIMIT_METADATA,
      context.getHandler(),
    )
    if (!options) return true

    const request = context.switchToHttp().getRequest<Request>()
    const whitelist = options.whitelist ?? this.server.rateLimitWhitelist
    const ip = clientIp(request, this.server.rateLimitTrustProxy)

    if (isIpWhitelisted(ip, whitelist)) return true

    const decision = await this.rateLimiter.check(
      `${options.scope}:${ip}`,
      options.limit ?? 20,
      options.windowSeconds ?? 60,
    )
    if (!decision.allowed) {
      const descriptor = describeErrorCode(AppErrorCodes.RateLimited)
      throw new BoundaryError(
        descriptor.value,
        descriptor.label,
        descriptor.http,
        { 'Retry-After': String(decision.retryAfterSeconds) },
      )
    }
    return true
  }
}
