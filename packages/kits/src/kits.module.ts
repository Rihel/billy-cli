import { RedisModule } from '@nestjs-modules/ioredis'
import { DynamicModule, Global, Module, type Provider } from '@nestjs/common'
import { DbService } from './database.js'
import { AppLoggerService } from './logger.js'
import {
  DATABASE_MODULE_OPTIONS,
  KITS_MODULE_OPTIONS,
  LOGGER_MODULE_OPTIONS,
  type KitsModuleOptions,
} from './options.js'
import { RedisService } from './redis.js'

@Global()
@Module({})
export class KitsModule {
  static forRoot(options: KitsModuleOptions = {}): DynamicModule {
    const imports = []
    const providers: Provider[] = [
      { provide: KITS_MODULE_OPTIONS, useValue: options },
      {
        provide: LOGGER_MODULE_OPTIONS,
        useValue: options.logger ?? {},
      },
      AppLoggerService,
    ]
    const exportedProviders: NonNullable<DynamicModule['exports']> = [
      KITS_MODULE_OPTIONS,
      LOGGER_MODULE_OPTIONS,
      AppLoggerService,
    ]

    if (options.database) {
      providers.push(
        {
          provide: DATABASE_MODULE_OPTIONS,
          useValue: options.database,
        },
        DbService,
      )
      exportedProviders.push(DATABASE_MODULE_OPTIONS, DbService)
    }

    if (options.redis) {
      imports.push(
        RedisModule.forRoot({
          type: 'single',
          url: options.redis.url,
          options: { keyPrefix: options.redis.keyPrefix },
        }),
      )
      providers.push(RedisService)
      exportedProviders.push(RedisService)
    }

    return {
      global: true,
      module: KitsModule,
      imports,
      providers,
      exports: exportedProviders,
    }
  }
}
