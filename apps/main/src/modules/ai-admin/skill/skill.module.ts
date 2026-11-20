import { Module } from '@nestjs/common'
import { AdminModule } from '../../admin/admin.module.js'
import { SkillAdminController } from './skill.controller.js'
import { EventBusSkillChangeNotifier } from './skill.notifier.js'
import { SKILL_CHANGE_NOTIFIER } from './skill.ports.js'
import { SkillRepository } from './skill.repository.js'
import { SkillAdminService } from './skill.service.js'
import { SkillGrantController } from './skill-grant.controller.js'
import { SkillGrantRepository } from './skill-grant.repository.js'
import { SkillGrantService } from './skill-grant.service.js'
import { SKILL_SYNC_PORT, SkillSyncService } from './skill-sync.service.js'
import { WorkspaceServiceClient } from '@repo/internal-sdk'

/**
 * main 本地的技能管理模块（`/ai-skill/*`）。
 *
 * 装配方式（见交付说明）：
 * 1. `RootModule.imports` 加 `AiSkillAdminModule`；
 * 2. **同时从 `AiModule` 移除** `SkillController` / `SkillLibraryService` / `SkillRepository`
 *    —— 否则两处都注册 `/ai-skill/*`，Nest 启动时路由重复、行为取决于注册顺序。
 *
 * 本模块**不依赖 `modules/ai`**：没有 Mastra、没有 agent loop、没有落盘。
 * 变更后通过 `SKILL_CHANGE_NOTIFIER` 发 Redis 事件，由 agent-runtime 负责落盘与刷新。
 * `EventBus` 来自 kits 的全局 `EventBusModule`（`RootModule` 已装配）。
 */
@Module({
  imports: [AdminModule],
  controllers: [SkillAdminController, SkillGrantController],
  providers: [
    SkillRepository,
    SkillAdminService,
    SkillGrantRepository,
    SkillGrantService,
    SkillSyncService,
    {
      // 与凭据同步同一套地址 / 令牌；sync 时顺带收敛技能目录
      provide: SKILL_SYNC_PORT,
      useFactory: () => {
        const client = new WorkspaceServiceClient({
          baseUrl: process.env.WORKSPACE_SERVICE_URL?.trim() || 'http://127.0.0.1:9995',
          token:
            process.env.WORKSPACE_INTERNAL_TOKEN?.trim() ||
            process.env.TOOL_INTERNAL_TOKEN?.trim() ||
            'dev-workspace-token',
        })
        return {
          status: (workspaceId: string) => client.status(workspaceId),
          sync: (workspaceId: string) => client.sync(workspaceId, undefined, { skills: true }),
        }
      },
    },
    { provide: SKILL_CHANGE_NOTIFIER, useClass: EventBusSkillChangeNotifier },
  ],
  exports: [SkillAdminService, SkillRepository],
})
export class AiSkillAdminModule {}
