import { Global, Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common'
import { requestContextMiddleware } from './request-context.middleware.js'

/**
 * 请求上下文模块：自注册 ALS 中间件（`forRoutes('*')`），业务侧直接 `import { requestContext }`
 * 读写（守卫写身份、service / repository 读身份），无需注入任何 provider。
 *
 * **顺序规定（两条一起才成立）**：
 * 1. 必须标 `@Global()`：Nest 12 装配中间件时按模块 distance 排序，**全局模块的中间件排在最前**
 *    （`middleware-module.js`：`distance === Number.MAX_VALUE` 视为全局，排序权重 -1），
 *    不标则会被其它全局模块的中间件压在后面；
 * 2. 全局模块之间按容器注册顺序（即组合根 `imports` 顺序）稳定排序，因此本模块必须写在
 *    `RequestLoggerModule` / `RequestMetricsModule` **之前**。
 *
 * 顺序错了的后果：请求日志 / 指标中间件在响应结束时读不到 ALS 里的 requestId / userId / adminId
 * （日志丢掉登录身份、requestId 与响应头对不上）。
 */
@Global()
@Module({})
export class RequestContextModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(requestContextMiddleware).forRoutes('*')
  }
}
