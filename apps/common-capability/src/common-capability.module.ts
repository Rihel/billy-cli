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
  type WorkspaceFsPort,
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
      useFactory: (client: WorkspaceServiceClient): WorkspaceFsPort => ({
        async readText(workspaceId, path) {
          const r = await client.fs({ workspaceId, op: 'read', path })
          if (!r.ok) throw new Error(r.message ?? '读取失败')
          return String((r.data as { content?: string }).content ?? '')
        },
        async readBytes(workspaceId, path) {
          const r = await client.fs({ workspaceId, op: 'read-bytes', path })
          if (!r.ok) throw new Error(r.message ?? '读取失败')
          return Buffer.from(String((r.data as { base64?: string }).base64 ?? ''), 'base64')
        },
        async writeBytes(workspaceId, path, body) {
          const r = await client.fs({
            workspaceId,
            op: 'write-bytes',
            path,
            base64: body.toString('base64'),
          })
          if (!r.ok) throw new Error(r.message ?? '写入失败')
        },
        async writeText(workspaceId, path, content) {
          const r = await client.fs({ workspaceId, op: 'write', path, content })
          if (!r.ok) throw new Error(r.message ?? '写入失败')
        },
        async appendText(workspaceId, path, content) {
          const r = await client.fs({ workspaceId, op: 'append', path, content })
          if (!r.ok) throw new Error(r.message ?? '追加失败')
        },
        async stat(workspaceId, path) {
          const r = await client.fs({ workspaceId, op: 'stat', path })
          if (!r.ok) throw new Error(r.message ?? '读取状态失败')
          const data = (r.data ?? {}) as { type?: 'file' | 'dir'; size?: number; mtime?: number }
          return {
            type: data.type ?? 'file',
            size: data.size ?? 0,
            ...(data.mtime === undefined ? {} : { mtime: data.mtime }),
          }
        },
        async list(workspaceId, path) {
          const r = await client.fs({ workspaceId, op: 'list', path })
          if (!r.ok) throw new Error(r.message ?? '列目录失败')
          return (
            (
              r.data as {
                entries?: { name: string; path: string; type?: 'file' | 'dir'; size?: number }[]
              }
            ).entries ?? []
          ).map((entry) => ({
            name: entry.name,
            path: entry.path,
            type: entry.type ?? 'file',
            size: entry.size ?? 0,
          }))
        },
        async remove(workspaceId, path) {
          const r = await client.fs({ workspaceId, op: 'remove', path })
          if (!r.ok) throw new Error(r.message ?? '删除失败')
        },
        async search(workspaceId, path, query) {
          const r = await client.fs({ workspaceId, op: 'search', path, query })
          if (!r.ok) throw new Error(r.message ?? '搜索失败')
          return (r.data as { matches?: string[] }).matches ?? []
        },
      }),
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
