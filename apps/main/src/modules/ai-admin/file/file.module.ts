import { Module } from '@nestjs/common'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { FileRepository, FileService, FILE_CAPS } from '@repo/ai-data'
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
