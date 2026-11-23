import { Module } from '@nestjs/common'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  FileRepository,
  FileService,
  FILE_CAPS,
  WORKSPACE_FS_PORT,
  createWorkspaceFsPort,
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
      useFactory: (client: WorkspaceServiceClient) => createWorkspaceFsPort(client),
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
