import { Controller, Post, Body, UseGuards, Inject } from '@nestjs/common';
import { AuthService } from './auth.service.js';
import {
  RegisterDto,
  LoginDto,
  ForgotPasswordDto,
  ResetPasswordDto,
  UpdateInfoDto,
  ChangePasswordDto,
} from '@repo/shared';
import { z } from 'zod';
import { AuthGuard } from '../../guards/auth.guard.js';
import { UserId } from '../../decorators/user-id.decorator.js';

@Controller('api/auth')
export class AuthController {
  constructor(@Inject(AuthService) private readonly authService: AuthService) {}

  @Post('register')
  register(@Body() input: z.infer<typeof RegisterDto>) {
    return this.authService.register(input);
  }

  @Post('login')
  login(@Body() input: z.infer<typeof LoginDto>) {
    return this.authService.login(input);
  }

  @Post('forgot-password')
  forgotPassword(@Body() input: z.infer<typeof ForgotPasswordDto>) {
    return this.authService.forgotPassword(input);
  }

  @Post('reset-password')
  resetPassword(@Body() input: z.infer<typeof ResetPasswordDto>) {
    return this.authService.resetPassword(input);
  }

  @Post('get-me')
  @UseGuards(AuthGuard)
  getMe(@UserId() userId: string) {
    return this.authService.getMe(userId);
  }

  @Post('update-info')
  @UseGuards(AuthGuard)
  updateInfo(
    @UserId() userId: string,
    @Body() input: z.infer<typeof UpdateInfoDto>,
  ) {
    return this.authService.updateInfo(userId, input);
  }

  @Post('change-password')
  @UseGuards(AuthGuard)
  changePassword(
    @UserId() userId: string,
    @Body() input: z.infer<typeof ChangePasswordDto>,
  ) {
    return this.authService.changePassword(userId, input);
  }
}
