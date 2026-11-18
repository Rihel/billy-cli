import { Module } from '@nestjs/common'
import { AdminModule } from '../../admin/admin.module.js'
import { AiToolAdminController } from './tool-admin.controller.js'
import { AiToolAdminRepository, AI_TOOL_ADMIN_REPOSITORY } from './tool-admin.repository.js'
import { AiToolAdminService } from './tool-admin.service.js'

/**
 * AI 工具管理模块（`/ai-tool/*`）—— **main 本地**的控制面。
 *
 * 只做配置 CRUD + 工作区能力探测：不 import `modules/ai`（agent loop / Mastra / 工具执行器），
 * 工具元数据来自本地快照（`tool-manifests.ts`），配置行落在 `ai_tools`。
 *
 * - `AdminModule`：`AdminAuthGuard` 依赖 `AdminService`（鉴权）；
 * - `WorkspaceRuntimeService` 由根模块已装配的 `WorkspaceModule`（`@Global`）提供；
 * - `AI_TOOL_ADMIN_REPOSITORY` 是指向真实仓储的 token，便于 service 单测替换。
 */
@Module({
  imports: [AdminModule],
  controllers: [AiToolAdminController],
  providers: [
    AiToolAdminRepository,
    { provide: AI_TOOL_ADMIN_REPOSITORY, useExisting: AiToolAdminRepository },
    AiToolAdminService,
  ],
  exports: [AiToolAdminService],
})
export class AiToolAdminModule {}
