import { Module } from '@nestjs/common';
import { KitsModule, RequestContextModule } from '@repo/kits';
import { appConfig } from '../config.js';

export interface ContextData {
  userId: string | null
}

@Module({
  imports: [
    KitsModule.forRoot({
      database: { url: appConfig.dbUrl },
      redis: {
        url: appConfig.redisUrl,
        keyPrefix: 'billy-cli:',
      },
      logger: { pretty: appConfig.isDev },
    }),
    RequestContextModule.forRoot<ContextData>({
      defaultStoreFactory: () => ({
        userId: null,
      }),
    }),
  ],
})
export class InfraModule {}
