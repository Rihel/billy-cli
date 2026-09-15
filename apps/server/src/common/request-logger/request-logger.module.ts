import { Global, Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common'
import { RequestLoggerMiddleware } from './request-logger.middleware.js'

/**
 * 请求日志模块：自注册全局中间件（`forRoutes('*')`）。
 *
 * 顺序铁律（替代原先「RequestContextModule 必须早于 kits LoggerModule」那条）：
 * 本中间件要在响应结束时从 ALS 读 requestId / userId / adminId，因此必须排在
 * `RequestContextModule` **之后**。两者都是 `@Global()`，Nest 12 让全局模块的中间件排在最前、
 * 全局模块之间按组合根 `imports` 顺序稳定装配，所以 `root.module.ts` 里
 * `RequestContextModule` 写在 `RequestLoggerModule` 之前。
 */
@Global()
@Module({})
export class RequestLoggerModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestLoggerMiddleware).forRoutes('*')
  }
}
