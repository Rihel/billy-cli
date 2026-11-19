import {
  Body,
  Controller,
  ForbiddenException,
  Headers,
  HttpCode,
  Inject,
  Post,
  UseFilters,
} from '@nestjs/common'
import { AppExceptionFilter } from '@repo/kits'
import { z } from 'zod'
import { WorkspaceTaskManager } from './task.manager.js'
import { WorkspaceServiceConfig, type WorkspaceServiceConfigValue } from '../config/app-config.js'

const TaskQuerySchema = z.object({
  taskId: z.string().min(1).max(128),
  waitMs: z.number().int().nonnegative().max(60_000).optional(),
})

/** 网关的 `/tasks/get|cancel` 回连（task 形态的能力） */
@Controller()
@UseFilters(AppExceptionFilter)
export class WorkspaceTaskController {
  constructor(
    @Inject(WorkspaceTaskManager) private readonly tasks: WorkspaceTaskManager,
    @Inject(WorkspaceServiceConfig) private readonly config: WorkspaceServiceConfigValue,
  ) {}

  private check(token: string | undefined): void {
    if (token !== this.config.internalToken && token !== this.config.gatewayToken) {
      throw new ForbiddenException('内部令牌不正确')
    }
  }

  @Post('tasks/get')
  @HttpCode(200)
  get(@Headers('x-internal-token') token: string | undefined, @Body() body: unknown) {
    this.check(token)
    const input = TaskQuerySchema.parse(body)
    return this.tasks.get(input.taskId, input.waitMs ?? 0)
  }

  @Post('tasks/cancel')
  @HttpCode(200)
  cancel(@Headers('x-internal-token') token: string | undefined, @Body() body: unknown) {
    this.check(token)
    const input = TaskQuerySchema.parse(body)
    return this.tasks.cancel(input.taskId)
  }
}
