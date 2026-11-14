import { ForbiddenException, Inject, Injectable } from '@nestjs/common'
import type { CanActivate, ExecutionContext } from '@nestjs/common'
import { ModelGatewayConfig, type ModelGatewayConfigValue } from '../config/app-config.js'

/** 内部令牌守卫：除健康检查外的所有端点都从这里过 */
@Injectable()
export class InternalTokenGuard implements CanActivate {
  constructor(@Inject(ModelGatewayConfig) private readonly config: ModelGatewayConfigValue) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{ headers: Record<string, unknown> }>()
    if (request.headers['x-internal-token'] !== this.config.internalToken) {
      throw new ForbiddenException('内部令牌不匹配')
    }
    return true
  }
}
