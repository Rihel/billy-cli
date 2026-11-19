import { Module } from '@nestjs/common'
import { AdminModule } from '../../admin/admin.module.js'
import { WorkspaceAdminController } from './workspace.controller.js'
import { WorkspaceCoreModule } from './workspace.core.module.js'

/** 工作区管理路由（`/ai-workspace/*`）：AdminModule 提供守卫，核心逻辑在 WorkspaceCoreModule */
@Module({
  imports: [AdminModule, WorkspaceCoreModule],
  controllers: [WorkspaceAdminController],
})
export class WorkspaceAdminModule {}
