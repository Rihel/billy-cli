import { Module } from '@nestjs/common'
import { ConfigModule, ConfigService } from '@nestjs/config'
import {
  AiCapabilityServiceEntity,
  AiServiceGrantEntity,
  AiToolAuditEntity,
  AiToolEntity,
} from '@repo/db'
import {
  AppConfigModule,
  DbModule,
  IdGenerationModule,
  LoggerModule,
  RedisModule,
  type DbConfig,
  type LoggerConfig,
  type RedisConfig,
} from '@repo/kits'
import { ToolGatewayModule } from './gateway/gateway.module.js'

/**
 * 组合根（网关）：
 *
 * - 不连主库、不装 Mastra、不装工具实现；
 * - Redis 只用于发现 worker（注册表）；工具配置 / 审计表后续从 server 内部接口与 PG 补。
 */
@Module({
  imports: [
    IdGenerationModule,
    AppConfigModule.forRoot(),
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
    DbModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        ...config.getOrThrow<DbConfig>('db'),
        entities: [
          AiToolAuditEntity,
          AiToolEntity,
          AiCapabilityServiceEntity,
          AiServiceGrantEntity,
        ],
      }),
    }),
    ToolGatewayModule,
  ],
})
export class RootModule {}
