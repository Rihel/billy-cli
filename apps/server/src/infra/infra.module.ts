import { Module } from '@nestjs/common';
import {
  LoggerModule,
  DatabaseModule,
  RedisModule,
  RequestContextModule,
} from '@repo/kits';
import { appConfig } from '../config.js';

export interface ContextData {
  userId: string | null
}

@Module({
  imports: [
    LoggerModule.forRoot({ pretty: appConfig.isDev }),
    DatabaseModule.forRoot({ url: appConfig.dbUrl }),
    RedisModule.forRoot({
      url: appConfig.redisUrl,
      keyPrefix: 'billy-cli:',
    }),
    RequestContextModule.forRoot<ContextData>({
      defaultStoreFactory: () => ({
        userId: null,
      }),
    }),
  ],
})
export class InfraModule {}