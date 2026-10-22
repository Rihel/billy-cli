import 'reflect-metadata'
import 'dotenv/config'
import { ConfigService } from '@nestjs/config'
import { NestFactory } from '@nestjs/core'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { NestLoggerAdapter, setAuditUserProvider } from '@repo/kits'
import { RootModule } from './root.module.js'
import { loadServerAppConfig } from './app-config.js'
import { resolveServerConfig } from './config.js'
import { requestContext } from './common/index.js'
import { MonitorEngine } from './modules/monitor/index.js'

/**
 * 应用入口（NestJS 12 + Express）。
 *
 * 配置链路：bootstrap 首行 `loadServerAppConfig()`（zod 校验 + 补默认值 + 缓存），
 * 之后由 `AppConfigModule` 接进 Nest，各基础设施 `forRootAsync` 惰性取配置。
 *
 * 日志为自建 logger（`@repo/shared/logger` 的 createLogger，不再依赖 nestjs-pino）：
 * - `bufferLogs: true` 先把启动期日志缓冲，`app.useLogger(app.get(NestLoggerAdapter))` 之后
 *   Nest 自身的框架日志（InstanceLoader / RoutesResolver 等）经适配器落到同一个 pino 实例；
 * - 请求日志由 `common/request-logger` 的自注册中间件记录（含 requestId / 状态码 / 耗时 / 登录身份）。
 *
 * 请求级横切中间件（请求上下文 ALS / 请求日志 / 请求指标）由 `common/` 的三个自注册模块装配，
 * 本文件只负责引导与全局 Express 配置（CORS / body 上限）。
 *
 * 审计操作人：TypeORM 的订阅者由它自己实例化（拿不到 Nest 容器），所以在这里挂一次
 * `setAuditUserProvider`，把「当前操作人」接到请求上下文（无上下文时由 kits 回落成 `system`）。
 */
export const program = async (): Promise<void> => {
  // 先加载并校验应用配置（AppConfigFacade 缓存），再创建应用：
  // 各模块的 forRootAsync 工厂与 ConfigModule 的 load 工厂都会读这份缓存
  await loadServerAppConfig()

  const app = await NestFactory.create<NestExpressApplication>(RootModule, {
    bodyParser: false,
    bufferLogs: true,
  })
  app.useLogger(app.get(NestLoggerAdapter))
  // 适配器即 Nest 的 LoggerService：`(message, context?)`，错误对象会带出堆栈
  const logger = app.get(NestLoggerAdapter)

  // 审计操作人来源：优先前台用户，其次后台管理员；无请求上下文（启动期脚本）时 kits 记为 system
  setAuditUserProvider(
    // `requestContext.get` 缺失时返回 null（ALS 未启用或未登录），转成 undefined 交给 kits 回落
    () => requestContext.get('userId') ?? requestContext.get('adminId') ?? undefined,
  )

  app.enableCors()
  // 不暴露服务端指纹响应头
  app.disable('x-powered-by')
  // 请求体上限（Express 默认 100kb 偏小；模板统一 2mb，足够 Markdown / 批量 JSON）
  app.useBodyParser('json', { limit: '2mb' })
  app.useBodyParser('urlencoded', { limit: '2mb', extended: true })

  const config = resolveServerConfig(app.get(ConfigService))

  // 空闲长连接 / 请求头超时：必须比前置网关（Kong 等）的**上游空闲超时**更长，
  // 否则网关会在「它以为连接还能复用」的窗口里往已关闭的 socket 发请求 → 间歇 502
  // （后端日志无痕，因为请求没到应用）。默认 75s / 80s，取值与理由见 app-config.ts。
  const httpServer = app.getHttpServer()
  httpServer.keepAliveTimeout = config.keepAliveTimeoutMs
  httpServer.headersTimeout = config.headersTimeoutMs

  await app.listen(config.port)
  logger.log(`服务已启动: http://localhost:${config.port}`, 'bootstrap')

  // 进程级异常告警：未捕获异常记录后退出（避免进程悬挂）；未处理拒绝记录不退出
  // 约定：适配器的最后一个字符串参数是 context，故「中文标签」作为附加参数带上
  process.on('uncaughtException', (error) => {
    logger.error(error, '未捕获异常', 'bootstrap')
    try {
      void app.get(MonitorEngine).ingestError(error)
    } catch {
      // 告警链路异常不影响退出
    }
    process.exit(1)
  })
  process.on('unhandledRejection', (reason) => {
    logger.error(reason, '未处理的 Promise 拒绝', 'bootstrap')
    try {
      void app.get(MonitorEngine).ingestError(reason)
    } catch {
      // 忽略
    }
  })

  let closing = false
  const shutdown = async (signal: string): Promise<void> => {
    if (closing) return
    closing = true
    const startedAtMs = Date.now()
    const timeoutMs = config.shutdownTimeoutMs
    logger.log(`收到 ${signal}，正在关闭服务（排空期限 ${timeoutMs}ms）...`, 'bootstrap')

    // 排空超时兜底：app.close() 内部依次执行
    // ① beforeApplicationShutdown —— StreamHub 推 stream.shutdown 并关闭全部 SSE 长连接
    //    （不做这一步，SSE 长连接会让 httpServer.close() 永不返回）；
    // ② httpServer.close() —— 停止接收新连接并等在途请求结束；
    // ③ 各资源 onApplicationShutdown。
    // 若在途请求迟迟不结束，这里强制退出：否则进程会卡到 terminationGracePeriodSeconds
    // 被 SIGKILL——那样连「为什么没关掉」都留不下日志。
    const forceExit = setTimeout(() => {
      logger.error(
        `关闭超时（${timeoutMs}ms），强制退出；未完成的在途请求会被中断`,
        'bootstrap',
      )
      process.exit(1)
    }, timeoutMs)

    try {
      await app.close()
      clearTimeout(forceExit)
      logger.log(
        `服务已关闭（耗时 ${Date.now() - startedAtMs}ms）`,
        'bootstrap',
      )
    } catch (error) {
      clearTimeout(forceExit)
      logger.error(error, '关闭资源失败', 'bootstrap')
    }
    process.exit(0)
  }
  process.once('SIGINT', () => void shutdown('SIGINT'))
  process.once('SIGTERM', () => void shutdown('SIGTERM'))
}

void program()
