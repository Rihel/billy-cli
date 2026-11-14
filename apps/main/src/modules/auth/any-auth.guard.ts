import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common'
import { anyOfGuards } from '../../common/index.js'
import { AdminAuthGuard } from '../admin/admin-auth.guard.js'
import { UserAuthGuard } from './user-auth.guard.js'

/**
 * 「前台用户或后台管理员」守卫：任一身份通过即可放行。
 *
 * 为什么需要它：`UserAuthGuard` 与 `AdminAuthGuard` 是两套互不相通的身份体系，
 * 而部分能力对两端都要开放（对象存储上传 / 会话管理 / SSE 订阅）。挂在控制器上时
 * 无法用配置二选一，也不能只挂一个 —— 那会让另一半完全不可用。
 *
 * 身份分域由调用方自行判断（读 `requestContext.get('userId')` / `get('adminId')`），
 * 例如存储的 key 前缀约束、会话管理的「谁的会话」。
 *
 * 放在认证模块（两个身份体系的共同归属）：`AuthModule` 为此 import `AdminModule`
 * （无环，AdminModule 不反向依赖 AuthModule），并把它 export 给业务模块复用。
 */
@Injectable()
export class AnyAuthGuard implements CanActivate {
  constructor(
    @Inject(UserAuthGuard) private readonly userGuard: UserAuthGuard,
    @Inject(AdminAuthGuard) private readonly adminGuard: AdminAuthGuard,
  ) {}

  canActivate(context: ExecutionContext): Promise<boolean> {
    return anyOfGuards([this.userGuard, this.adminGuard], context)
  }
}
