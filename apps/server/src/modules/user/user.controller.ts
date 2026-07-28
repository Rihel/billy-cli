import { Controller, Post, UseGuards, Inject } from '@nestjs/common';
import { UserService } from './user.service.js';
import {
  CreateUserDto,
  GetUserDetailDto,
  PageQueryUserDto,
  RemoveUserDto,
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

  @Post('page-query')
  findMany(@ZBody(PageQueryUserDto) input: z.infer<typeof PageQueryUserDto>) {
    return this.userService.pageQuery(input);
  }

  @Post('detail')
  findById(@ZBody(GetUserDetailDto) input: z.infer<typeof GetUserDetailDto>) {
    return this.userService.detail(input);
  }

  @Post('update')
  update(@ZBody(UpdateUserDto) input: z.infer<typeof UpdateUserDto>) {
    return this.userService.update(input);
  }

  @Post('remove')
  remove(@ZBody(RemoveUserDto) input: z.infer<typeof RemoveUserDto>) {
    return this.userService.remove(input);
  }

  @Post('reset-password')
  resetPassword(
    @ZBody(ResetUserPasswordDto) input: z.infer<typeof ResetUserPasswordDto>,
  ) {
    return this.userService.resetPassword(input);
  }
}
