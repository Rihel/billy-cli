import { Global, Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common'
import { RequestMetricsMiddleware } from './request-metrics.middleware.js'

/**
 * 请求指标模块：自注册全局埋点中间件（`forRoutes('*')`）。
 *
 * - 标 `@Global()` 与 `RequestContextModule` 同理：Nest 12 让全局模块的中间件排在最前，
 *   不标会排到 kits 全局 `LoggerModule`（pino-http）之后（此处顺序无强依赖，但保持一致）；
 * - 依赖 `Telemetry`（`TelemetryModule` 为 `@Global()`，由组合根装配后可直接注入）；
 * - 用中间件而非拦截器：被守卫拒绝的 401 / 403 / 429 也要计入 QPS。
 */
@Global()
@Module({})
export class RequestMetricsModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestMetricsMiddleware).forRoutes('*')
  }
}
