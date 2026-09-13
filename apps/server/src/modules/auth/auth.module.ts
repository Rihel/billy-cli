import { Module } from '@nestjs/common'
import { UserModule } from '../user/user.module.js'
import { AuthController } from './auth.controller.js'
import { AuthService } from './auth.service.js'
import { UserAuthGuard } from './user-auth.guard.js'

/**
 * 前台认证模块：提供 AuthService（用户 / 管理员登录态校验的公共入口）与 UserAuthGuard。
 * 依赖 UserModule 的 UserRepository（注册 / 找回密码 / 用户信息）。
 */
@Module({
  imports: [UserModule],
  controllers: [AuthController],
  providers: [AuthService, UserAuthGuard],
  exports: [AuthService, UserAuthGuard],
})
export class AuthModule {}
