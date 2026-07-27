import { Global, Module, RequestMethod } from '@nestjs/common'
import type { DynamicModule, MiddlewareConsumer, NestModule } from '@nestjs/common'
import { REQUEST_CONTEXT_OPTIONS } from './request-context.types.js'
import type { RequestContextAsyncOptions, RequestContextOptions } from './request-context.types.js'
import { RequestContextMiddleware } from './request-context.middleware.js'
import { RequestContextService } from './request-context.service.js'

@Global()
@Module({})
export class RequestContextModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(RequestContextMiddleware).forRoutes({
      path: '*',
      method: RequestMethod.ALL,
    })
  }

  static forRoot<T extends Record<string, any>>(options: RequestContextOptions<T>): DynamicModule {
    return {
      module: RequestContextModule,
      providers: [
        RequestContextService,
        { provide: REQUEST_CONTEXT_OPTIONS, useValue: options },
      ],
      exports: [RequestContextService],
    }
  }

  static forRootAsync<T extends Record<string, any>>(options: RequestContextAsyncOptions<T>): DynamicModule {
    return {
      module: RequestContextModule,
      imports: options.imports || [],
      providers: [
        RequestContextService,
        {
          provide: REQUEST_CONTEXT_OPTIONS,
          useFactory: options.useFactory,
          inject: options.inject || [],
        },
      ],
      exports: [RequestContextService],
    }
  }
}

export * from './request-context.decorator.js'
export * from './request-context.service.js'
export * from './request-context.store.js'
export * from './request-context.types.js'
