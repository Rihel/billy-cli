import 'reflect-metadata'
import 'dotenv/config'
import { ConfigService } from '@nestjs/config'
import { NestFactory } from '@nestjs/core'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { Logger } from '@repo/kits'
import { RootModule } from './root.module.js'
import { loadServerAppConfig } from './app-config.js'
import { resolveServerConfig } from './config.js'
import { AlertTrigger } from './modules/monitor/index.js'

/**
 * 应用入口（NestJS 12 + Express）。
 *
 * 配置链路：bootstrap 首行 `loadServerAppConfig()`（zod 校验 + 补默认值 + 缓存），
 * 之后由 `AppConfigModule` 接进 Nest，各基础设施 `forRootAsync` 惰性取配置。
 *
 * 日志采用 nestjs-pino（对齐 rihel-base）：
 * - `bufferLogs: true` 先把启动期日志缓冲，`app.useLogger(app.get(Logger))` 之后
 *   Nest 自身的框架日志（InstanceLoader / RoutesResolver 等）与业务日志走同一条 pino 通道；
 * - 请求日志由 pino-http 自动记录（含 req.id / 状态码 / 耗时，按状态码分级）。
 *
 * 请求级横切中间件（请求上下文 ALS / 请求指标）由 `common/` 的 `RequestContextModule` /
 * `RequestMetricsModule` 自注册，本文件只负责引导与全局 Express 配置（CORS / body 上限）。
 */
export const program = async (): Promise<void> => {
  // 先加载并校验应用配置（AppConfigFacade 缓存），再创建应用：
  // 各模块的 forRootAsync 工厂与 ConfigModule 的 load 工厂都会读这份缓存
  await loadServerAppConfig()

  const app = await NestFactory.create<NestExpressApplication>(RootModule, {
    bodyParser: false,
    bufferLogs: true,
  })
  app.useLogger(app.get(Logger))
  const logger = app.get(Logger)

  app.enableCors()
  // 不暴露服务端指纹响应头
  app.disable('x-powered-by')
  // 请求体上限（Express 默认 100kb 偏小；模板统一 2mb，足够 Markdown / 批量 JSON）
  app.useBodyParser('json', { limit: '2mb' })
  app.useBodyParser('urlencoded', { limit: '2mb', extended: true })

  const config = resolveServerConfig(app.get(ConfigService))
  await app.listen(config.port)
  logger.log(`服务已启动: http://localhost:${config.port}`, 'bootstrap')

  // 进程级异常告警：未捕获异常记录后退出（避免进程悬挂）；未处理拒绝记录不退出
  process.on('uncaughtException', (error) => {
    logger.error(error, '未捕获异常')
    try {
      void app.get(AlertTrigger).notifyError(error)
    } catch {
      // 告警链路异常不影响退出
    }
    process.exit(1)
  })
  process.on('unhandledRejection', (reason) => {
    logger.error(reason as Error, '未处理的 Promise 拒绝')
    try {
      void app.get(AlertTrigger).notifyError(reason)
    } catch {
      // 忽略
    }
  })

  let closing = false
  const shutdown = async (signal: string): Promise<void> => {
    if (closing) return
    closing = true
    logger.log(`收到 ${signal}，正在关闭服务...`, 'bootstrap')
    try {
      await app.close()
      logger.log('服务已关闭', 'bootstrap')
    } catch (error) {
      logger.error(error as Error, '关闭资源失败')
    }
    process.exit(0)
  }
  process.once('SIGINT', () => void shutdown('SIGINT'))
  process.once('SIGTERM', () => void shutdown('SIGTERM'))
}

void program()
