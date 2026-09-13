import {
  Body,
  Controller,
  HttpCode,
  Inject,
  Post,
  UseGuards,
} from '@nestjs/common'
import {
  AdminLoginSchema,
  ChangePasswordSchema,
  CreateAdminSchema,
  GetAdminDetailSchema,
  PageQueryAdminSchema,
  RemoveAdminSchema,
  ResetAdminPasswordSchema,
  UpdateAdminSchema,
  UpdateInfoSchema,
} from '@repo/shared'
import type {
  AdminLoginDto,
  ChangePasswordDto,
  CreateAdminDto,
  GetAdminDetailDto,
  PageQueryAdminDto,
  RemoveAdminDto,
  ResetAdminPasswordDto,
  UpdateAdminDto,
  UpdateInfoDto,
} from '@repo/shared'
import { AccessToken, RateLimit, RateLimitGuard, currentAdminId } from '../../common/index.js'
import { AdminAuthGuard } from './admin-auth.guard.js'
import { AdminService } from './admin.service.js'

/**
 * 后台管理员「免鉴权」路由（/admin/login、/admin/logout）。
 * 与 AdminController 共用 `admin` 前缀，用两个控制器区分鉴权边界（Nest 守卫是方法/类级，无路由级 use('*')）。
 */
@Controller('admin')
export class AdminAuthController {
  constructor(@Inject(AdminService) private readonly adminService: AdminService) {}

  @Post('login')
  @HttpCode(200)
  @UseGuards(RateLimitGuard)
  @RateLimit({ scope: 'admin-login' })
  login(@Body({ schema: AdminLoginSchema }) input: AdminLoginDto) {
    return this.adminService.login(input)
  }

  /** 登出幂等：token 有效则撤销会话，无效也返回成功（不要求登录态） */
  @Post('logout')
  @HttpCode(200)
  logout(@AccessToken() token?: string) {
    return token
      ? this.adminService.logout({ token })
      : Promise.resolve({ success: true })
  }
}

/** 后台管理员业务路由（/admin/*，除上面两个外全部 admin 鉴权） */
@Controller('admin')
@UseGuards(AdminAuthGuard)
export class AdminController {
  constructor(@Inject(AdminService) private readonly adminService: AdminService) {}

  @Post('get-me')
  @HttpCode(200)
  getMe() {
    return this.adminService.getMe({ adminId: currentAdminId() })
  }

  @Post('update-info')
  @HttpCode(200)
  updateInfo(@Body({ schema: UpdateInfoSchema }) input: UpdateInfoDto) {
    return this.adminService.updateInfo({
      adminId: currentAdminId(),
      ...input,
    })
  }

  @Post('change-password')
  @HttpCode(200)
  changePassword(@Body({ schema: ChangePasswordSchema }) input: ChangePasswordDto) {
    return this.adminService.changePassword({
      adminId: currentAdminId(),
      ...input,
    })
  }

  @Post('create')
  @HttpCode(200)
  create(@Body({ schema: CreateAdminSchema }) input: CreateAdminDto) {
    return this.adminService.create(input)
  }

  @Post('page-query')
  @HttpCode(200)
  pageQuery(@Body({ schema: PageQueryAdminSchema }) input: PageQueryAdminDto) {
    return this.adminService.page(input)
  }

  @Post('detail')
  @HttpCode(200)
  detail(@Body({ schema: GetAdminDetailSchema }) input: GetAdminDetailDto) {
    return this.adminService.get(input)
  }

  @Post('update')
  @HttpCode(200)
  update(@Body({ schema: UpdateAdminSchema }) input: UpdateAdminDto) {
    return this.adminService.update(input)
  }

  @Post('remove')
  @HttpCode(200)
  remove(@Body({ schema: RemoveAdminSchema }) input: RemoveAdminDto) {
    return this.adminService.remove({
      ...input,
      operatorId: currentAdminId(),
    })
  }

  @Post('reset-password')
  @HttpCode(200)
  resetPassword(@Body({ schema: ResetAdminPasswordSchema }) input: ResetAdminPasswordDto) {
    return this.adminService.resetPassword(input)
  }
}
