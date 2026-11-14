import 'reflect-metadata'
import 'dotenv/config'
import { ConfigService } from '@nestjs/config'
import { NestFactory } from '@nestjs/core'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { NestLoggerAdapter } from '@repo/kits'
import { loadModelGatewayAppConfig, type ModelGatewayConfigValue } from './config/app-config.js'
import { RootModule } from './root.module.js'

/**
 * model-gateway 入口（9992，只在内网）。
 *
 * 职责：路由转发（4 套协议适配）、模型目录、后续的计量 / key 池 / 配额。
 * 不跑 agent loop、不碰会话/时间线、不写 `ai_files`。
 */
const program = async (): Promise<void> => {
  await loadModelGatewayAppConfig()

  // 请求体可能带多模态 base64：放宽到 20MB；流式响应需要禁用压缩
  const app = await NestFactory.create<NestExpressApplication>(RootModule, {
    bufferLogs: true,
    bodyParser: false,
  })
  app.useBodyParser('json', { limit: '20mb' })
  app.useLogger(app.get(NestLoggerAdapter))
  app.enableShutdownHooks()

  const config = app.get(ConfigService)
  const server = config.getOrThrow<{ port: number }>('server')
  const gateway = config.getOrThrow<ModelGatewayConfigValue>('gateway')
  const logger = app.get(NestLoggerAdapter)

  if (process.env.NODE_ENV === 'production' && gateway.internalToken === 'dev-model-token') {
    logger.error('生产环境必须配置 MODEL_INTERNAL_TOKEN，拒绝启动', 'bootstrap')
    process.exit(1)
  }

  await app.listen(server.port)
  logger.log(`model-gateway 已启动: http://localhost:${server.port}`, 'bootstrap')
}

void program()
