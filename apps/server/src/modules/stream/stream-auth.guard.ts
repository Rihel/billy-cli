import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common'
import { AdminAuthGuard } from '../admin/admin-auth.guard.js'
import { UserAuthGuard } from '../auth/user-auth.guard.js'
import { SSE_ROUTE_OPTIONS, type SseRouteOptions } from './stream.options.js'

/** SSE 鉴权守卫：按 SSE_ROUTE_OPTIONS.auth 委派给用户 / 管理员守卫 */
@Injectable()
export class StreamAuthGuard implements CanActivate {
  constructor(
    @Inject(SSE_ROUTE_OPTIONS)
    private readonly options: Required<SseRouteOptions>,
    @Inject(UserAuthGuard) private readonly userGuard: UserAuthGuard,
    @Inject(AdminAuthGuard) private readonly adminGuard: AdminAuthGuard,
  ) {}

  canActivate(context: ExecutionContext): boolean | Promise<boolean> {
    return this.options.auth === 'admin'
      ? this.adminGuard.canActivate(context)
      : this.userGuard.canActivate(context)
  }
}
