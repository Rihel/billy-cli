import { Module } from '@nestjs/common'
import { ConfigModule, ConfigService } from '@nestjs/config'
import {
  AppConfigModule,
  CommandModule,
  DbModule,
  IdGenerationModule,
  LoggerModule,
  RedisModule,
  WorkspaceModule,
  type DbConfig,
  type LoggerConfig,
  type WorkspaceConfigValue,
} from '@repo/kits'
import {
  AdminEntity,
  AiSkillEntity,
  AiSkillFileEntity,
  AiSkillGrantEntity,
  AiWorkspaceEntity,
  AiWorkspaceSetupEntity,
  ConversationEntity,
  PersonalCredentialEntity,
} from '@repo/db'
import { WorkspaceServiceModule } from './workspace/workspace.module.js'

/**
 * workspace-service 的组合根。
 *
 * 基础设施：DB（只读 `ai_workspaces`）、日志、沙箱（local 后端）。
 * 单副本不连 Redis；`WORKSPACE_MULTI_INSTANCE=true` 时装配 RedisModule，
 * 用分布式锁 / 共享 lastUsed 支持多副本（对象存储仍不持有）。
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
        // 执行面对这些表**只读**：工作区 / 会话定位 + 初始化阶段（清单 / 技能 / 凭据名）
        entities: [
          AdminEntity,
          AiWorkspaceEntity,
          ConversationEntity,
          AiWorkspaceSetupEntity,
          AiSkillEntity,
          AiSkillFileEntity,
          // 技能可见性按授权过滤（`workspace.repository.listVisibleSkills`）；
          // 漏登记会在运行期抛 EntityMetadataNotFoundError，且初始化有兜底会把错误吞成 warn
          AiSkillGrantEntity,
          PersonalCredentialEntity,
        ],
      }),
    }),
    LoggerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => config.getOrThrow<LoggerConfig>('logger'),
    }),
    // 多副本才连 Redis：单副本保持执行面不依赖 Redis 的现状
    ...(process.env.WORKSPACE_MULTI_INSTANCE && process.env.WORKSPACE_MULTI_INSTANCE !== 'false'
      ? [
          RedisModule.forRootAsync({
            imports: [ConfigModule],
            inject: [ConfigService],
            useFactory: (config: ConfigService) => config.getOrThrow('redis'),
          }),
        ]
      : []),
    CommandModule,
    WorkspaceModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => config.getOrThrow<WorkspaceConfigValue>('workspace'),
    }),
    WorkspaceServiceModule,
  ],
})
export class RootModule {}
