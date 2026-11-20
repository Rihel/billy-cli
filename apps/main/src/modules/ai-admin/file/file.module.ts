import { Module } from '@nestjs/common'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  FileRepository,
  FileService,
  FILE_CAPS,
  WORKSPACE_FS_PORT,
  type WorkspaceFsPort,
} from '@repo/ai-data'
import { WorkspaceServiceClient } from '@repo/internal-sdk'
import { AdminModule } from '../../admin/index.js'
import { AuthModule } from '../../auth/index.js'
import { AiAdminConversationModule } from '../conversation/conversation.module.js'
import { AiFileController } from './file.controller.js'

@Module({
  imports: [AuthModule, AdminModule, AiAdminConversationModule],
  controllers: [AiFileController],
  providers: [
    FileRepository,
    FileService,
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
        async listTree(workspaceId, path, options) {
          const r = await client.fs({
            workspaceId,
            op: 'list-tree',
            path,
            maxDepth: options.maxDepth,
            excludeDirs: [...options.excludeDirs],
          })
          if (!r.ok) throw new Error(r.message ?? '列目录失败')
          const data = (r.data ?? {}) as {
            entries?: { path?: string; size?: number; mtime?: number }[]
          }
          return (data.entries ?? [])
            .filter((entry): entry is { path: string; size?: number; mtime?: number } =>
              Boolean(entry.path),
            )
            .map((entry) => ({
              path: entry.path,
              size: entry.size ?? 0,
              mtime: entry.mtime ?? 0,
            }))
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
    {
      provide: FILE_CAPS,
      useFactory: () => ({
        command: {
          workDir: process.env.AGENT_COMMAND_WORK_DIR ?? join(homedir(), '.billy', 'workspaces'),
        },
      }),
    },
  ],
})
export class AiFileAdminModule {}
