import { Controller, Post, Body, UseGuards, Inject } from '@nestjs/common';
import { UserService } from './user.service.js';
import {
  CreateUserDto,
  PageQueryUserDto,
  ResetUserPasswordDto,
  UpdateUserDto,
  UserIdInputDto,
} from '@repo/shared';
import { z } from 'zod';
import { AuthGuard } from '../../guards/auth.guard.js';

@Controller('user')
@UseGuards(AuthGuard)
export class UserController {
  constructor(@Inject(UserService) private readonly userService: UserService) {}

  @Post('create')
  create(@Body() input: z.infer<typeof CreateUserDto>) {
    return this.userService.create(input);
  }

  @Post('find-many')
  findMany(@Body() input: z.infer<typeof PageQueryUserDto>) {
    return this.userService.findMany(input);
  }

  @Post('find-by-id')
  findById(@Body() input: z.infer<typeof UserIdInputDto>) {
    return this.userService.findById(input.userId);
  }

  @Post('update')
  update(@Body() input: z.infer<typeof UpdateUserDto>) {
    return this.userService.update(input);
  }

  @Post('remove')
  remove(@Body() input: z.infer<typeof UserIdInputDto>) {
    return this.userService.remove(input.userId);
  }

  @Post('reset-password')
  resetPassword(@Body() input: z.infer<typeof ResetUserPasswordDto>) {
    return this.userService.resetPassword(input);
  }
}
