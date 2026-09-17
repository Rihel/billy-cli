import { Module } from '@nestjs/common'
import { AdminModule } from '../admin/admin.module.js'
import { AuthModule } from '../auth/auth.module.js'
import { SessionController } from './session.controller.js'
import { SessionService } from './session.service.js'

/**
 * 会话（登录设备）模块：列表 + 单设备下线，前台用户与后台管理员共用一套接口。
 *
 * 鉴权用 `AuthModule` 导出的 `AnyAuthGuard`；**两个模块都要 import** ——
 * `@UseGuards(具体类)` 是 Nest 增强器，在本模块的注入上下文里实例化，
 * 它的依赖（UserAuthGuard / AdminAuthGuard）必须能从本模块 imports 解析到。
 *
 * 会话存储是 kits 的 `SessionStore`（@Global 注入），本模块无需配置。
 */
@Module({
  imports: [AuthModule, AdminModule],
  controllers: [SessionController],
  providers: [SessionService],
})
export class SessionModule {}
