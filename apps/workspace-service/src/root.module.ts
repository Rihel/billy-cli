import { Module } from '@nestjs/common'
import { ConfigModule, ConfigService } from '@nestjs/config'
import {
  AppConfigModule,
  CommandModule,
  DbModule,
  IdGenerationModule,
  LoggerModule,
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
 * 只接它需要的基础设施：DB（只读 `ai_workspaces`）、日志、沙箱（local 后端）。
 * 不连 Redis / 对象存储 —— 执行面不持有这些。
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
