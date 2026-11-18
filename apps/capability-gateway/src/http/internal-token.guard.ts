import { ForbiddenException, Inject, Injectable } from '@nestjs/common'
import type { CanActivate, ExecutionContext } from '@nestjs/common'
import { ToolGatewayConfig, type ToolGatewayConfigValue } from '../config/app-config.js'

/** 内部令牌守卫：所有 gateway 端点（含健康检查之外的调试端点）都从这里过 */
@Injectable()
export class InternalTokenGuard implements CanActivate {
  constructor(@Inject(ToolGatewayConfig) private readonly config: ToolGatewayConfigValue) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{ headers: Record<string, unknown> }>()
    if (request.headers['x-internal-token'] !== this.config.internalToken) {
      throw new ForbiddenException('内部令牌不匹配')
    }
    return true
  }
}
