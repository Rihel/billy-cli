import { Controller, Post, Body, UseGuards, Inject } from '@nestjs/common';
import { AuthService } from './auth.service.js';
import {
  RegisterDto,
  LoginDto,
  ForgotPasswordDto,
  ResetPasswordDto,
  UpdateInfoDto,
  ChangePasswordDto,
  AuthResultModel,
  SuccessResultModel,
} from '@repo/shared';
import type { z } from 'zod';
import { ZBody, ZSerialize } from 'nest-zod';
import { AuthGuard } from '../../guards/auth.guard.js';
import { RequestContext } from '@repo/kits';

@Controller('auth')
export class AuthController {
  constructor(@Inject(AuthService) private readonly authService: AuthService) {}

  @Post('register')
  @ZSerialize(AuthResultModel)
  register(@ZBody(RegisterDto) input: z.infer<typeof RegisterDto>) {
    return this.authService.register(input);
  }

  @Post('login')
  @ZSerialize(AuthResultModel)
  login(@ZBody(LoginDto) input: z.infer<typeof LoginDto>) {
    return this.authService.login(input);
  }

  @Post('forgot-password')
  @ZSerialize(SuccessResultModel)
  forgotPassword(@ZBody(ForgotPasswordDto) input: z.infer<typeof ForgotPasswordDto>) {
    return this.authService.forgotPassword(input);
  }

  @Post('reset-password')
  @ZSerialize(SuccessResultModel)
  resetPassword(@ZBody(ResetPasswordDto) input: z.infer<typeof ResetPasswordDto>) {
    return this.authService.resetPassword(input);
  }

  @Post('get-me')
  @UseGuards(AuthGuard)
  getMe(@RequestContext('userId') userId: string) {
    return this.authService.getMe(userId);
  }

  @Post('update-info')
  @UseGuards(AuthGuard)
  updateInfo(
    @RequestContext('userId') userId: string,
    @ZBody(UpdateInfoDto) input: z.infer<typeof UpdateInfoDto>,
  ) {
    return this.authService.updateInfo(userId, input);
  }

  @Post('change-password')
  @UseGuards(AuthGuard)
  @ZSerialize(SuccessResultModel)
  changePassword(
    @RequestContext('userId') userId: string,
    @ZBody(ChangePasswordDto) input: z.infer<typeof ChangePasswordDto>,
  ) {
    return this.authService.changePassword(userId, input);
  }
}
