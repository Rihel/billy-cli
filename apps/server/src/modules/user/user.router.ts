import { Inject } from '@nestjs/common';
import { Router, Query, Mutation, Input, UseMiddlewares } from 'nestjs-trpc';
import {
  CreateUserDto,
  PageQueryUserDto,
  ResetUserPasswordDto,
  UpdateUserDto,
  UserIdInputDto,
} from '@repo/shared';
import { z } from 'zod';
import { UserService } from './user.service.js';
import { AuthMiddleware } from '../../middlewares/auth.middleware.js';

@Router({ alias: 'user' })
@UseMiddlewares(AuthMiddleware)
export class UserRouter {
  constructor(@Inject(UserService) private readonly userService: UserService) {}

  @Mutation({ input: CreateUserDto })
  create(@Input() input: z.infer<typeof CreateUserDto>) {
    return this.userService.create(input);
  }

  @Query({ input: PageQueryUserDto })
  findMany(@Input() input: z.infer<typeof PageQueryUserDto>) {
    return this.userService.findMany(input);
  }

  @Query({ input: UserIdInputDto })
  findById(@Input('userId') userId: string) {
    return this.userService.findById(userId);
  }

  @Mutation({ input: UpdateUserDto })
  update(@Input() input: z.infer<typeof UpdateUserDto>) {
    return this.userService.update(input);
  }

  @Mutation({ input: UserIdInputDto })
  remove(@Input('userId') userId: string) {
    return this.userService.remove(userId);
  }

  @Mutation({ input: ResetUserPasswordDto })
  resetPassword(@Input() input: z.infer<typeof ResetUserPasswordDto>) {
    return this.userService.resetPassword(input);
  }
}
