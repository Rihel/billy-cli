import { Module } from '@nestjs/common'
import { ConfigModule, ConfigService } from '@nestjs/config'
import {
  AiModelEntity,
  AiProviderEntity,
  AiProviderKeyEntity,
  ModelGatewayUsageEntity,
} from '@repo/db'
import {
  AppConfigModule,
  DbModule,
  EventBusModule,
  PubSubModule,
  IdGenerationModule,
  LoggerModule,
  RedisModule,
  type DbConfig,
  type LoggerConfig,
  type RedisConfig,
} from '@repo/kits'
import { ModelGatewayModule } from './model-gateway.module.js'

/**
 * 组合根（模型网关）。
 *
 * - 只读 `ai_providers` / `ai_models`，不写业务库；
 * - 不 import `@mastra/*`、不碰会话/时间线/文件表；
 * - 配置变更后续经 Redis 事件失效缓存（P4.2b），当前靠 TTL。
 */
@Module({
  imports: [
    AppConfigModule.forRoot(),
    LoggerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => config.getOrThrow<LoggerConfig>('logger'),
    }),
    IdGenerationModule,
    PubSubModule,
    EventBusModule,
    RedisModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => config.getOrThrow<RedisConfig>('redis'),
    }),
    DbModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        ...config.getOrThrow<DbConfig>('db'),
        entities: [AiProviderEntity, AiModelEntity, AiProviderKeyEntity, ModelGatewayUsageEntity],
      }),
    }),
    ModelGatewayModule,
  ],
})
export class RootModule {}
