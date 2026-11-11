import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import type { Request } from 'express'
import {
  extractToken,
  requestContext,
  tokenInvalidError,
  unauthorizedError,
} from '../../common/index.js'
import { resolveServerConfig, type ServerConfig } from '../../config.js'
import { AuthService } from './auth.service.js'

/**
 * 前台用户鉴权守卫：校验用户 token，把 userId 注入请求上下文。
 * 用户体系开关（ServerConfig.authEnabled）关闭时直接放行。
 */
@Injectable()
export class UserAuthGuard implements CanActivate {
  /** 应用级业务配置（bootstrap 前已加载校验，构造期解析一次即可） */
  private readonly server: ServerConfig

  constructor(
    @Inject(AuthService) private readonly authService: AuthService,
    @Inject(ConfigService) config: ConfigService,
  ) {
    this.server = resolveServerConfig(config)
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (!this.server.authEnabled) return true

    const token = extractToken(context.switchToHttp().getRequest<Request>(), 'user')
    if (!token) throw unauthorizedError()

    try {
      const userId = await this.authService.verifyToken({ token })
      requestContext.set('userId', userId)
      return true
    } catch {
      throw tokenInvalidError()
    }
  }
}
