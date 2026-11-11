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
import { AdminService } from './admin.service.js'

/**
 * 后台管理员鉴权守卫：校验管理员 token（type='admin'），把 adminId 注入请求上下文。
 * 用户体系开关（ServerConfig.authEnabled）关闭时直接放行。
 */
@Injectable()
export class AdminAuthGuard implements CanActivate {
  /** 应用级业务配置（bootstrap 前已加载校验，构造期解析一次即可） */
  private readonly server: ServerConfig

  constructor(
    @Inject(AdminService) private readonly adminService: AdminService,
    @Inject(ConfigService) config: ConfigService,
  ) {
    this.server = resolveServerConfig(config)
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (!this.server.authEnabled) return true

    const token = extractToken(context.switchToHttp().getRequest<Request>(), 'admin')
    if (!token) throw unauthorizedError()

    try {
      const adminId = await this.adminService.verifyToken({ token })
      requestContext.set('adminId', adminId)
      return true
    } catch {
      throw tokenInvalidError()
    }
  }
}
