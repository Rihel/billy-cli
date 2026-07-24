import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthService } from './auth.service.js';
import { AuthRouter } from './auth.router.js';
import { AuthMiddleware } from '../../middlewares/auth.middleware.js';
import { appConfig } from '../../config.js';
import type { StringValue } from 'ms';

@Module({
  imports: [
    JwtModule.register({
      secret: appConfig.jwtSecret,
      signOptions: { expiresIn: appConfig.jwtExpiresIn as StringValue },
    }),
  ],
  providers: [AuthService, AuthRouter, AuthMiddleware],
  exports: [AuthService, JwtModule],
})
export class AuthModule {}
