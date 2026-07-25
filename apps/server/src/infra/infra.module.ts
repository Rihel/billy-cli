import { Global, Module } from '@nestjs/common';
import { DbService } from './db.service.js';
import { RedisModule } from '@nestjs-modules/ioredis';
import { appConfig } from '../config.js';
import { RedisService } from './redis.service.js';
import { AppLoggerService } from './logger.service.js';

const providers = [DbService, RedisService, AppLoggerService];

@Global()
@Module({
  imports: [
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
