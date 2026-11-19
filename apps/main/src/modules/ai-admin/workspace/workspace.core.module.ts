import { Module } from '@nestjs/common'
import { WorkspaceAdminService } from './workspace.service.js'

/**
 * 工作区的**核心写方**（只依赖 Db / Logger，不依赖 AdminModule）。
 *
 * 单独成模块是为了让 `AdminModule` 能注入它做「默认工作区初始化」，
 * 同时不让 `AdminModule` 反向依赖控制器模块（避免循环）。
 */
@Module({
  providers: [WorkspaceAdminService],
  exports: [WorkspaceAdminService],
})
export class WorkspaceCoreModule {}
