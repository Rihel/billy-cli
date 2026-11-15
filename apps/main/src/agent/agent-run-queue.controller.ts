import { Body, Controller, HttpCode, Inject, Post, UseGuards } from '@nestjs/common'
import {
  AgentRunQueueListSchema,
  AgentRunQueueRemoveSchema,
  AgentRunQueueUpdateSchema,
  type AgentRunQueueListDto,
  type AgentRunQueueRemoveDto,
  type AgentRunQueueUpdateDto,
} from '@repo/shared'
import { AnyAuthGuard } from '../modules/auth/index.js'
import { AgentRunQueueService } from './agent-run-queue.service.js'

/** 会话输入框上方的待执行队列（当前登录用户自己的会话） */
@Controller('agent/queue')
@UseGuards(AnyAuthGuard)
export class AgentRunQueueController {
  constructor(@Inject(AgentRunQueueService) private readonly queue: AgentRunQueueService) {}

  @Post('list')
  @HttpCode(200)
  list(@Body({ schema: AgentRunQueueListSchema }) input: AgentRunQueueListDto) {
    return this.queue.list(input)
  }

  @Post('update')
  @HttpCode(200)
  update(@Body({ schema: AgentRunQueueUpdateSchema }) input: AgentRunQueueUpdateDto) {
    return this.queue.update(input)
  }

  @Post('remove')
  @HttpCode(200)
  remove(@Body({ schema: AgentRunQueueRemoveSchema }) input: AgentRunQueueRemoveDto) {
    return this.queue.remove(input)
  }
}
