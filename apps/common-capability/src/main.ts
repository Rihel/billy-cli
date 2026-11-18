import 'reflect-metadata'
import 'dotenv/config'
import { ConfigService } from '@nestjs/config'
import { NestFactory } from '@nestjs/core'
import { NestLoggerAdapter } from '@repo/kits'
import { loadToolWorkerAppConfig, type ToolWorkerConfigValue } from './config/app-config.js'
import { RootModule } from './root.module.js'

/**
 * common-capability 入口。
 *
 * 独立进程：只有执行能力（bash），不连主库、不持 provider key。
 * 配置在创建 Nest 应用前加载校验；各基础设施用 `forRootAsync` 惰性取分片。
 */
const program = async (): Promise<void> => {
  await loadToolWorkerAppConfig()

  const app = await NestFactory.create(RootModule, { bufferLogs: true })
  app.useLogger(app.get(NestLoggerAdapter))
  app.enableShutdownHooks()

  const config = app.get(ConfigService)
  const server = config.getOrThrow<{ port: number }>('server')
  const worker = config.getOrThrow<ToolWorkerConfigValue>('worker')
  const logger = app.get(NestLoggerAdapter)

  if (process.env.NODE_ENV === 'production' && worker.internalToken === 'dev-tool-token') {
    logger.error('生产环境必须配置 TOOL_INTERNAL_TOKEN，拒绝启动', 'bootstrap')
    process.exit(1)
  }

  await app.listen(server.port)
  logger.log(
    `common-capability 已启动: http://localhost:${server.port}（${worker.id}）`,
    'bootstrap',
  )
}

void program()
