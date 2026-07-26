import { Module } from '@nestjs/common';
import { KitsModule } from '@repo/kits';
import { appConfig } from '../config.js';

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
  ],
})
export class InfraModule {}
