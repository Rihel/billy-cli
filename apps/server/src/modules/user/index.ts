import { Module } from '@nestjs/common';
import { UserService } from './user.service.js';
import { UserRouter } from './user.router.js';
import { AuthMiddleware } from '../../middlewares/auth.middleware.js';

@Module({
  providers: [UserService, UserRouter, AuthMiddleware],
})
export class UserModule {}
