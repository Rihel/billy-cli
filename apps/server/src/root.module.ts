import { Module } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { InfraModule } from './infra/infra.module.js';
import { TodoModule } from './modules/todo/index.js';
import { AuthModule } from './modules/auth/index.js';
import { UserModule } from './modules/user/index.js';
import { StorageModule } from './modules/storage/index.js';
import { AuthGuard } from './guards/auth.guard.js';
import { ResponseInterceptor } from './interceptors/response.interceptor.js';
import { AppExceptionFilter } from './filters/app-exception.filter.js';
import { appConfig } from './config.js';

@Module({
  imports: [
    InfraModule,
    StorageModule.forRoot({
      provider: appConfig.storage.provider,
      region: appConfig.storage.region,
      bucket: appConfig.storage.bucket,
      accessKeyId: appConfig.storage.accessKeyId,
      secretAccessKey: appConfig.storage.secretAccessKey,
      endpoint: appConfig.storage.endpoint,
    }),
    AuthModule,
    TodoModule,
    UserModule,
  ],
  providers: [
    AuthGuard,
    { provide: APP_INTERCEPTOR, useClass: ResponseInterceptor },
    { provide: APP_FILTER, useClass: AppExceptionFilter },
  ],
})
export class RootModule {}
