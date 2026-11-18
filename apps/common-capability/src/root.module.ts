import { Module } from '@nestjs/common'
import { ConfigModule, ConfigService } from '@nestjs/config'
import {
  AppConfigModule,
  CommandModule,
  DbModule,
  IdGenerationModule,
  LoggerModule,
  ObjectStorageModule,
  RedisModule,
  WorkspaceModule,
  type DbConfig,
  type LoggerConfig,
  type StorageConfig,
  type RedisConfig,
  type WorkspaceConfigValue,
} from '@repo/kits'
import { AiFileEntity, AiMemoryEntity, ConversationEntity, TimelineEntity } from '@repo/db'
import { CommonCapabilityModule } from './common-capability.module.js'

/**
 * 组合根（worker）：
 *
 * - `AppConfigModule` 把 bootstrap 前加载的配置接进全局 `ConfigService`；
 * - 基础设施各自 `forRootAsync` 惰性取分片（日志 / Redis / 沙箱 / 命令）；
 * - 业务配置 `worker` 只在本模块解析一次，服务注入 token。
 */
@Module({
  imports: [
    IdGenerationModule,
    AppConfigModule.forRoot(),
    DbModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        ...config.getOrThrow<DbConfig>('db'),
        entities: [AiMemoryEntity, TimelineEntity, AiFileEntity, ConversationEntity],
      }),
    }),
    LoggerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => config.getOrThrow<LoggerConfig>('logger'),
    }),
    RedisModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => config.getOrThrow<RedisConfig>('redis'),
    }),
    ObjectStorageModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => config.getOrThrow<StorageConfig>('storage'),
    }),
    WorkspaceModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => config.getOrThrow<WorkspaceConfigValue>('workspace'),
    }),
    CommandModule,
    CommonCapabilityModule,
  ],
})
export class RootModule {}
