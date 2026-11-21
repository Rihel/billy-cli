import { Module } from '@nestjs/common'
import { ConfigModule, ConfigService } from '@nestjs/config'
import { WorkspaceServiceConfig, type WorkspaceServiceConfigValue } from '../config/app-config.js'
import { WorkspaceController } from './workspace.controller.js'
import { WorkspaceRepository } from './workspace.repository.js'
import { WorkspaceRuntime } from './workspace-runtime.service.js'
import { WorkspaceSetupService } from './workspace-setup.service.js'
import { WorkspaceCredentialClient } from './credential.client.js'
import { WorkspaceReaper } from './workspace-reaper.service.js'
import { WorkspaceInvokeController } from '../capabilities/invoke.controller.js'
import { BashExecutor } from '../capabilities/bash.executor.js'
import { FileExecutor } from '../capabilities/file.executor.js'
import {
  CredentialCandidatesExecutor,
  CredentialImportExecutor,
} from '../capabilities/credential.executor.js'
import { CredentialSaveExecutor } from '../capabilities/credential-save.executor.js'
import { WorkspaceCredentialImportService } from './credential-import.service.js'
import { WorkspaceCredentialSaveService } from './credential-save.service.js'
import { WorkspaceLocator } from '../capabilities/workspace.locator.js'
import { WorkspaceCapabilityRegistration } from '../capabilities/capability.registration.js'
import { WorkspaceTaskManager } from '../capabilities/task.manager.js'
import { WorkspaceTaskController } from '../capabilities/tasks.controller.js'

/** 执行面：控制器 + 运行时 + 只读仓储 + 回收器 */
@Module({
  imports: [ConfigModule],
  controllers: [WorkspaceController, WorkspaceInvokeController, WorkspaceTaskController],
  providers: [
    {
      provide: WorkspaceServiceConfig,
      inject: [ConfigService],
      useFactory: (config: ConfigService): WorkspaceServiceConfigValue =>
        config.getOrThrow<WorkspaceServiceConfigValue>('service'),
    },
    WorkspaceRepository,
    WorkspaceCredentialClient,
    WorkspaceSetupService,
    WorkspaceRuntime,
    WorkspaceReaper,
    WorkspaceLocator,
    BashExecutor,
    FileExecutor,
    WorkspaceTaskManager,
    WorkspaceCredentialImportService,
    WorkspaceCredentialSaveService,
    CredentialCandidatesExecutor,
    CredentialImportExecutor,
    CredentialSaveExecutor,
    WorkspaceCapabilityRegistration,
  ],
  exports: [WorkspaceRuntime],
})
export class WorkspaceServiceModule {}
