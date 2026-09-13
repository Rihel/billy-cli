import { Global, Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common'
import { requestContextMiddleware } from './request-context.middleware.js'

/**
 * 请求上下文模块：自注册 ALS 中间件（`forRoutes('*')`），业务侧直接 `import { requestContext }`
 * 读写（守卫写身份、service / repository 读身份），无需注入任何 provider。
 *
 * **顺序铁律（两条一起才成立）**：
 * 1. 必须标 `@Global()`：Nest 12 装配中间件时按模块 distance 排序，**全局模块的中间件排在最前**
 *    （`middleware-module.js`：`distance === Number.MAX_VALUE` 视为全局，排序权重 -1），
 *    不标则会被 kits 的全局 `LoggerModule`（内含 pino-http）压在后面；
 * 2. 全局模块之间按容器注册顺序（即组合根 `imports` 顺序）稳定排序，因此本模块必须写在
 *    `LoggerModule` **之前**。
 *
 * 顺序错了的后果：① pino 的 `genReqId` 取不到响应头 `X-Request-Id`（日志 requestId 与排查用响应头对不上）；
 * ② pino-http 的 `customProps` 读不到 ALS 里的 userId / adminId（请求日志丢掉登录身份）。
 */
@Global()
@Module({})
export class RequestContextModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(requestContextMiddleware).forRoutes('*')
  }
}
