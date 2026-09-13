import { Module } from '@nestjs/common'
import { AdminModule } from '../admin/admin.module.js'
import { UserController } from './user.controller.js'
import { UserRepository } from './user.repository.js'
import { UserService } from './user.service.js'

/**
 * 前台用户模块：用户 CRUD + 用户实体数据访问。
 * UserRepository 对外导出，供 AuthModule（注册 / 找回密码 / 登录校验）复用。
 */
@Module({
  imports: [AdminModule],
  controllers: [UserController],
  providers: [UserRepository, UserService],
  exports: [UserRepository, UserService],
})
export class UserModule {}
