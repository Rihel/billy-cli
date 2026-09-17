import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common'
import { AdminAuthGuard } from '../admin/admin-auth.guard.js'
import { UserAuthGuard } from '../auth/user-auth.guard.js'
import { SSE_ROUTE_OPTIONS, type SseRouteOptions } from './stream.options.js'

/**
 * SSE 鉴权守卫：按 SSE_ROUTE_OPTIONS.auth 委派给用户 / 管理员守卫。
 *
 * `auth: 'both'` 时**任一身份通过即可**：先试前台用户守卫，失败再试管理员守卫 ——
 * 守卫内部会把通过的身份写入请求上下文（`userId` / `adminId`），控制器的频道订阅据此决定。
 */
@Injectable()
export class StreamAuthGuard implements CanActivate {
  constructor(
    @Inject(SSE_ROUTE_OPTIONS)
    private readonly options: Required<SseRouteOptions>,
    @Inject(UserAuthGuard) private readonly userGuard: UserAuthGuard,
    @Inject(AdminAuthGuard) private readonly adminGuard: AdminAuthGuard,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (this.options.auth === 'admin') {
      return this.adminGuard.canActivate(context)
    }
    if (this.options.auth === 'user') {
      return this.userGuard.canActivate(context)
    }
    // 'both'：任一身份放行；两路都不通过时由管理员守卫抛出 401（错误语义与单身份模式一致）
    try {
      if (await this.userGuard.canActivate(context)) return true
    } catch {
      // 前台身份不可用（无 token / token 无效 / 是管理员 token），改试管理员身份
    }
    return this.adminGuard.canActivate(context)
  }
}
