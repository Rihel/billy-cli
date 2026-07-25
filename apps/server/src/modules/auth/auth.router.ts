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
  ChangePasswordDto,
  ForgotPasswordDto,
  LoginDto,
  RegisterDto,
  ResetPasswordDto,
  UpdateInfoDto,
} from '@repo/shared';
import { z } from 'zod';
import { AuthService } from './auth.service.js';
import { AuthMiddleware } from '../../middlewares/auth.middleware.js';
import { ContextData } from '../../trpc.context.js';

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
  getMe(@Ctx() ctx: z.infer<typeof ContextData>) {
    return this.authService.getMe(ctx.userId);
  }

  @Mutation({ input: UpdateInfoDto })
  @UseMiddlewares(AuthMiddleware)
  updateInfo(
    @Ctx() ctx: z.infer<typeof ContextData>,
    @Input() input: z.infer<typeof UpdateInfoDto>,
  ) {
    return this.authService.updateInfo(ctx.userId, input);
  }

  @Mutation({ input: ChangePasswordDto })
  @UseMiddlewares(AuthMiddleware)
  changePassword(
    @Ctx() ctx: z.infer<typeof ContextData>,
    @Input() input: z.infer<typeof ChangePasswordDto>,
  ) {
    return this.authService.changePassword(ctx.userId, input);
  }
}
