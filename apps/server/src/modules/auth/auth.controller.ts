import {
  Body,
  Controller,
  HttpCode,
  Inject,
  Post,
  UseGuards,
} from '@nestjs/common'
import {
  ChangePasswordSchema,
  ForgotPasswordSchema,
  LoginSchema,
  RegisterSchema,
  ResetPasswordSchema,
  UpdateInfoSchema,
} from '@repo/shared'
import type {
  ChangePasswordDto,
  ForgotPasswordDto,
  LoginDto,
  RegisterDto,
  ResetPasswordDto,
  UpdateInfoDto,
} from '@repo/shared'
import {
  AccessToken,
  RateLimit,
  RateLimitGuard,
  currentUserId,
} from '../../common/index.js'
import { AuthService } from './auth.service.js'
import { UserAuthGuard } from './user-auth.guard.js'

/**
 * 前台认证路由（/auth/*）。全部 POST + HTTP 200（Nest 对 POST 默认 201，故显式 @HttpCode(200)）。
 * 敏感接口叠加 RateLimitGuard（按 IP 固定窗口，白名单豁免；防暴力破解 / 撞库）。
 */
@Controller('auth')
export class AuthController {
  constructor(@Inject(AuthService) private readonly authService: AuthService) {}

  @Post('register')
  @HttpCode(200)
  @UseGuards(RateLimitGuard)
  @RateLimit({ scope: 'register' })
  register(@Body({ schema: RegisterSchema }) input: RegisterDto) {
    return this.authService.register(input)
  }

  @Post('login')
  @HttpCode(200)
  @UseGuards(RateLimitGuard)
  @RateLimit({ scope: 'login' })
  login(@Body({ schema: LoginSchema }) input: LoginDto) {
    return this.authService.login(input)
  }

  /** 登出幂等：token 有效则撤销会话，无效也返回成功（不要求登录态） */
  @Post('logout')
  @HttpCode(200)
  logout(@AccessToken() token?: string) {
    return token
      ? this.authService.logout({ token })
      : Promise.resolve({ success: true })
  }

  @Post('forgot-password')
  @HttpCode(200)
  @UseGuards(RateLimitGuard)
  @RateLimit({ scope: 'forgot-password' })
  forgotPassword(@Body({ schema: ForgotPasswordSchema }) input: ForgotPasswordDto) {
    return this.authService.forgotPassword(input)
  }

  @Post('reset-password')
  @HttpCode(200)
  @UseGuards(RateLimitGuard)
  @RateLimit({ scope: 'reset-password' })
  resetPassword(@Body({ schema: ResetPasswordSchema }) input: ResetPasswordDto) {
    return this.authService.resetPassword(input)
  }

  @Post('get-me')
  @HttpCode(200)
  @UseGuards(UserAuthGuard)
  getMe() {
    return this.authService.getMe({ userId: currentUserId() })
  }

  @Post('update-info')
  @HttpCode(200)
  @UseGuards(UserAuthGuard)
  updateInfo(@Body({ schema: UpdateInfoSchema }) input: UpdateInfoDto) {
    return this.authService.updateInfo({ userId: currentUserId(), ...input })
  }

  @Post('change-password')
  @HttpCode(200)
  @UseGuards(UserAuthGuard)
  changePassword(@Body({ schema: ChangePasswordSchema }) input: ChangePasswordDto) {
    return this.authService.changePassword({
      userId: currentUserId(),
      ...input,
    })
  }
}
