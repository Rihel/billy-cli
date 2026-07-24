import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { RootModule } from './root.module.js';
import { createLogger } from '@repo/shared';
import { appConfig } from './config.js';

async function bootstrap() {
  const logger = createLogger('bootstrap');
  const app = await NestFactory.create(RootModule, { bufferLogs: true });
  app.useLogger(logger);
  app.flushLogs();
  app.enableCors();
  await app.listen(appConfig.port, () => {
    logger.info(`服务已启动 http://localhost:${appConfig.port}`, appConfig);
  });
}
bootstrap();
