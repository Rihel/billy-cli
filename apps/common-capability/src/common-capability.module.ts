import { Module } from '@nestjs/common'
import { ConfigModule, ConfigService } from '@nestjs/config'
import { ToolWorkerConfig, type ToolWorkerConfigValue } from './config/app-config.js'
import { BashExecutor } from './executors/bash.executor.js'
import { WorkspaceLocator } from './executors/workspace.locator.js'
import { WorkspaceServiceClient } from '@repo/internal-sdk'
import { ToolExecutorRegistry } from './executors/executor.registry.js'
import { WebFetchExecutor } from './tools/web/web-fetch.executor.js'
import { WebSearchExecutor } from './tools/web/web-search.executor.js'
import { WebRequestExecutor } from './tools/web/web-request.executor.js'
import { MemoryRepository, MemoryService } from '@repo/ai-data'
import { MemoryExecutor } from './tools/memory/memory.executor.js'
import {
  FileRepository,
  FileService,
  FILE_CAPS,
  WORKSPACE_FS_PORT,
  createWorkspaceFsPort,
} from '@repo/ai-data'
import { FileExecutor } from './tools/file/file.executor.js'
import { ReadToolResultExecutor } from './tools/read-tool-result.executor.js'
import { CapabilityInvokeController } from './invoke.controller.js'
import { OpsController } from './ops.controller.js'
import { CapabilityRegistration } from './capability.registration.js'
import { TaskManager } from './task.manager.js'
import { ToolWorkerService } from './worker.service.js'
import { ActiveTaskCounter } from './active-task.counter.js'

@Module({
  imports: [ConfigModule],
  controllers: [CapabilityInvokeController, OpsController],
  providers: [
    {
      provide: ToolWorkerConfig,
      inject: [ConfigService],
      useFactory: (config: ConfigService): ToolWorkerConfigValue =>
        config.getOrThrow<ToolWorkerConfigValue>('worker'),
    },
    BashExecutor,
    WorkspaceLocator,
    {
      provide: WorkspaceServiceClient,
      useFactory: () =>
        new WorkspaceServiceClient({
          baseUrl: process.env.WORKSPACE_SERVICE_URL?.trim() || 'http://127.0.0.1:9995',
          token:
            process.env.WORKSPACE_INTERNAL_TOKEN?.trim() ||
            process.env.TOOL_INTERNAL_TOKEN?.trim() ||
            'dev-workspace-token',
        }),
    },
    ToolExecutorRegistry,
    WebFetchExecutor,
    WebSearchExecutor,
    WebRequestExecutor,
    MemoryRepository,
    MemoryService,
    MemoryExecutor,
    {
      provide: WORKSPACE_FS_PORT,
      inject: [WorkspaceServiceClient],
      useFactory: (client: WorkspaceServiceClient) => createWorkspaceFsPort(client),
    },
    FileRepository,
    FileService,
    {
      provide: FILE_CAPS,
      inject: [ToolWorkerConfig],
      useFactory: (config: ToolWorkerConfigValue) => ({
        command: { workDir: config.workspaceRoot },
      }),
    },
    FileExecutor,
    ReadToolResultExecutor,
    ToolWorkerService,
    ActiveTaskCounter,
    CapabilityRegistration,
    TaskManager,
  ],
})
export class CommonCapabilityModule {}
