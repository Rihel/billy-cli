import { Module } from '@nestjs/common'
import { RuntimeConfigController } from './runtime-config.controller.js'

/** 运行配置路由模块（/config/get，公开）：配置经全局 ConfigService 惰性取 */
@Module({
  controllers: [RuntimeConfigController],
})
export class RuntimeConfigModule {}
