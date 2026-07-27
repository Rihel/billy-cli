import { RedisModule as IoredisModule } from '@nestjs-modules/ioredis'
import { DynamicModule, Global, Module } from '@nestjs/common'
import { RedisService } from './redis.service.js'
import type { RedisModuleOptions } from './redis.options.js'

@Global()
@Module({})
export class RedisModule {
  static forRoot(options: RedisModuleOptions): DynamicModule {
    return {
      module: RedisModule,
      imports: [
        IoredisModule.forRoot({
          type: 'single',
          url: options.url,
          options: { keyPrefix: options.keyPrefix },
        }),
      ],
      providers: [RedisService],
      exports: [RedisService],
    }
  }
}
