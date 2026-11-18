import 'reflect-metadata'
import 'dotenv/config'
import { ConfigService } from '@nestjs/config'
import { NestFactory } from '@nestjs/core'
import { NestLoggerAdapter } from '@repo/kits'
import { loadToolGatewayAppConfig, type ToolGatewayConfigValue } from './config/app-config.js'
import { RootModule } from './root.module.js'

/**
 * capability-gateway 入口。
 *
 * 独立进程：只做鉴权 / 选 worker / 超时 / 审计；不执行工具、不连主库。
 */
const program = async (): Promise<void> => {
  await loadToolGatewayAppConfig()

  const app = await NestFactory.create(RootModule, { bufferLogs: true })
  app.useLogger(app.get(NestLoggerAdapter))
  app.enableShutdownHooks()

  const config = app.get(ConfigService)
  const server = config.getOrThrow<{ port: number }>('server')
  const gateway = config.getOrThrow<ToolGatewayConfigValue>('gateway')
  const logger = app.get(NestLoggerAdapter)

  if (process.env.NODE_ENV === 'production' && gateway.internalToken === 'dev-tool-token') {
    logger.error('生产环境必须配置 TOOL_INTERNAL_TOKEN，拒绝启动', 'bootstrap')
    process.exit(1)
  }

  await app.listen(server.port)
  logger.log(`capability-gateway 已启动: http://localhost:${server.port}`, 'bootstrap')
}

void program()
