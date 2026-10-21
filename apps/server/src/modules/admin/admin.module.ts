import { Module } from '@nestjs/common'
import { AdminAuthGuard } from './admin-auth.guard.js'
import { AdminAuthController, AdminController } from './admin.controller.js'
import { AdminRepository } from './admin.repository.js'
import { AdminService } from './admin.service.js'

/**
 * 后台管理员模块：管理员鉴权体系（AdminService / AdminAuthGuard / 管理员 CRUD）。
 * AdminAuthGuard 需被其它业务模块复用（user / storage / monitor），故对外导出。
 */
@Module({
  controllers: [AdminAuthController, AdminController],
  providers: [AdminRepository, AdminService, AdminAuthGuard],
  exports: [AdminService, AdminAuthGuard],
})
export class AdminModule {}
