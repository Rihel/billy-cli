import { Controller, Post, UseGuards, Inject } from '@nestjs/common';
import { UserService } from './user.service.js';
import {
  CreateUserDto,
  PageQueryUserDto,
  ResetUserPasswordDto,
  UpdateUserDto,
  UserIdInputDto,
} from '@repo/shared';
import type { z } from 'zod';
import { ZBody } from 'nest-zod';
import { AuthGuard } from '../../guards/auth.guard.js';

@Controller('user')
@UseGuards(AuthGuard)
export class UserController {
  constructor(@Inject(UserService) private readonly userService: UserService) {}

  @Post('create')
  create(@ZBody(CreateUserDto) input: z.infer<typeof CreateUserDto>) {
    return this.userService.create(input);
  }

  @Post('find-many')
  findMany(@ZBody(PageQueryUserDto) input: z.infer<typeof PageQueryUserDto>) {
    return this.userService.findMany(input);
  }

  @Post('find-by-id')
  findById(@ZBody(UserIdInputDto) input: z.infer<typeof UserIdInputDto>) {
    return this.userService.findById(input.userId);
  }

  @Post('update')
  update(@ZBody(UpdateUserDto) input: z.infer<typeof UpdateUserDto>) {
    return this.userService.update(input);
  }

  @Post('remove')
  remove(@ZBody(UserIdInputDto) input: z.infer<typeof UserIdInputDto>) {
    return this.userService.remove(input.userId);
  }

  @Post('reset-password')
  resetPassword(@ZBody(ResetUserPasswordDto) input: z.infer<typeof ResetUserPasswordDto>) {
    return this.userService.resetPassword(input);
  }
}
