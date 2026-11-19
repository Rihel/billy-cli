import 'reflect-metadata'
import 'dotenv/config'
import { ConfigService } from '@nestjs/config'
import { NestFactory } from '@nestjs/core'
import { NestLoggerAdapter } from '@repo/kits'
import {
  loadWorkspaceServiceAppConfig,
  type WorkspaceServiceConfigValue,
} from './config/app-config.js'
import { RootModule } from './root.module.js'

/**
 * workspace-service 入口。
 *
 * 执行面：建/停/销毁容器、exec、fs；不写 `ai_workspaces`（main 是唯一写方）。
 */
const program = async (): Promise<void> => {
  await loadWorkspaceServiceAppConfig()

  const app = await NestFactory.create(RootModule, { bufferLogs: true })
  app.useLogger(app.get(NestLoggerAdapter))
  app.enableShutdownHooks()

  const config = app.get(ConfigService)
  const server = config.getOrThrow<{ port: number }>('server')
  const service = config.getOrThrow<WorkspaceServiceConfigValue>('service')
  const logger = app.get(NestLoggerAdapter)

  if (process.env.NODE_ENV === 'production' && service.internalToken === 'dev-workspace-token') {
    logger.error('生产环境必须配置 WORKSPACE_INTERNAL_TOKEN，拒绝启动', 'bootstrap')
    process.exit(1)
  }

  await app.listen(server.port)
  logger.log(`workspace-service 已启动: http://localhost:${server.port}`, 'bootstrap')
}

void program()
