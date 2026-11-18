import { Module } from '@nestjs/common'
import { ConfigModule, ConfigService } from '@nestjs/config'
import { ToolWorkerConfig, type ToolWorkerConfigValue } from './config/app-config.js'
import { BashExecutor } from './executors/bash.executor.js'
import { ToolExecutorRegistry } from './executors/executor.registry.js'
import { WebFetchExecutor } from './tools/web/web-fetch.executor.js'
import { WebSearchExecutor } from './tools/web/web-search.executor.js'
import { WebRequestExecutor } from './tools/web/web-request.executor.js'
import { MemoryRepository, MemoryService } from '@repo/ai-data'
import { MemoryExecutor } from './tools/memory/memory.executor.js'
import { FileRepository, FileService, FILE_CAPS } from '@repo/ai-data'
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
    ToolExecutorRegistry,
    WebFetchExecutor,
    WebSearchExecutor,
    WebRequestExecutor,
    MemoryRepository,
    MemoryService,
    MemoryExecutor,
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
