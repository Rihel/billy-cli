import { Global, Module } from '@nestjs/common';
import { DbService } from './db.service.js';
import { RedisModule } from '@nestjs-modules/ioredis';
import { appConfig } from '../config.js';
import { RedisService } from './redis.service.js';
import { AppLoggerService } from './logger.service.js';
import { StorageModule } from './storage/index.js';

const providers = [DbService, RedisService, AppLoggerService];

@Global()
@Module({
  imports: [
    StorageModule.forRoot({
      provider: appConfig.storage.provider,
      region: appConfig.storage.region,
      bucket: appConfig.storage.bucket,
      accessKeyId: appConfig.storage.accessKeyId,
      secretAccessKey: appConfig.storage.secretAccessKey,
      endpoint: appConfig.storage.endpoint,
    }),
    RedisModule.forRoot({
      options: {
        keyPrefix: 'billy-cli:',
      },
      type: 'single',
      url: appConfig.redisUrl,
    }),
  ],
  providers,
  exports: providers,
})
export class InfraModule {}
