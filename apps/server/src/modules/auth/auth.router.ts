import { Inject } from '@nestjs/common';
import {
  Router,
  Query,
  Mutation,
  Input,
  UseMiddlewares,
  Ctx,
} from 'nestjs-trpc';
import {
  ForgotPasswordDto,
  LoginDto,
  RegisterDto,
  ResetPasswordDto,
} from '@repo/shared';
import { z } from 'zod';
import { AuthService } from './auth.service.js';
import { AuthMiddleware } from '../../middlewares/auth.middleware.js';

@Router({ alias: 'auth' })
export class AuthRouter {
  constructor(@Inject(AuthService) private readonly authService: AuthService) {}

  @Mutation({ input: RegisterDto })
  register(@Input() input: z.infer<typeof RegisterDto>) {
    return this.authService.register(input);
  }

  @Mutation({ input: LoginDto })
  login(@Input() input: z.infer<typeof LoginDto>) {
    return this.authService.login(input);
  }

  @Mutation({ input: ForgotPasswordDto })
  forgotPassword(@Input() input: z.infer<typeof ForgotPasswordDto>) {
    return this.authService.forgotPassword(input);
  }

  @Mutation({ input: ResetPasswordDto })
  resetPassword(@Input() input: z.infer<typeof ResetPasswordDto>) {
    return this.authService.resetPassword(input);
  }

  @Query()
  @UseMiddlewares(AuthMiddleware)
  getMe(@Ctx() ctx: { userId: string }) {
    return this.authService.getMe(ctx.userId);
  }
}
