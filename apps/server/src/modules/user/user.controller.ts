import { Body, Controller, HttpCode, Inject, Post, UseGuards } from '@nestjs/common'
import {
  CreateUserSchema,
  GetUserDetailSchema,
  PageQueryUserSchema,
  RemoveUserSchema,
  ResetUserPasswordSchema,
  UpdateUserSchema,
} from '@repo/shared'
import type {
  CreateUserDto,
  GetUserDetailDto,
  PageQueryUserDto,
  RemoveUserDto,
  ResetUserPasswordDto,
  UpdateUserDto,
} from '@repo/shared'
import { AdminAuthGuard } from '../admin/admin-auth.guard.js'
import { UserService } from './user.service.js'

/** 前台用户管理路由（/user/*，全部后台管理员鉴权） */
@Controller('user')
@UseGuards(AdminAuthGuard)
export class UserController {
  constructor(@Inject(UserService) private readonly userService: UserService) {}

  @Post('create')
  @HttpCode(200)
  create(@Body({ schema: CreateUserSchema }) input: CreateUserDto) {
    return this.userService.create(input)
  }

  @Post('page-query')
  @HttpCode(200)
  pageQuery(@Body({ schema: PageQueryUserSchema }) input: PageQueryUserDto) {
    return this.userService.page(input)
  }

  @Post('detail')
  @HttpCode(200)
  detail(@Body({ schema: GetUserDetailSchema }) input: GetUserDetailDto) {
    return this.userService.get(input)
  }

  @Post('update')
  @HttpCode(200)
  update(@Body({ schema: UpdateUserSchema }) input: UpdateUserDto) {
    return this.userService.update(input)
  }

  @Post('remove')
  @HttpCode(200)
  remove(@Body({ schema: RemoveUserSchema }) input: RemoveUserDto) {
    return this.userService.remove(input)
  }

  @Post('reset-password')
  @HttpCode(200)
  resetPassword(@Body({ schema: ResetUserPasswordSchema }) input: ResetUserPasswordDto) {
    return this.userService.resetPassword(input)
  }
}
