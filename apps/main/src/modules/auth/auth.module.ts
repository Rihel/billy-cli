import { Module } from '@nestjs/common'
import { AdminModule } from '../admin/admin.module.js'
import { UserModule } from '../user/user.module.js'
import { AnyAuthGuard } from './any-auth.guard.js'
import { AuthController } from './auth.controller.js'
import { AuthService } from './auth.service.js'
import { UserAuthGuard } from './user-auth.guard.js'

/**
 * 前台认证模块：提供 AuthService（用户 / 管理员登录态校验的公共入口）、UserAuthGuard
 * 与 AnyAuthGuard（任一身份，供存储 / 会话 / SSE 复用）。依赖 UserModule 的 UserRepository
 * （注册 / 找回密码 / 用户信息）；AnyAuthGuard 需要 AdminAuthGuard，故 import AdminModule
 * （无环：AdminModule 不反向依赖本模块）。
 */
@Module({
  imports: [UserModule, AdminModule],
  controllers: [AuthController],
  providers: [AuthService, UserAuthGuard, AnyAuthGuard],
  exports: [AuthService, UserAuthGuard, AnyAuthGuard],
})
export class AuthModule {}
