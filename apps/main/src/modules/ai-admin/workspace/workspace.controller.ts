import { Body, Controller, HttpCode, Inject, Post, UseGuards } from '@nestjs/common'
import { requestContext } from '@repo/kits'
import { z } from 'zod'
import { AdminAuthGuard } from '../../admin/admin-auth.guard.js'
import { WorkspaceAdminService } from './workspace.service.js'

const IdSchema = z.object({ id: z.string().min(1).max(20) })
const BackendSchema = z.enum(['local', 'container', 'microvm'])
const FileAccessSchema = z.enum(['read-only', 'write'])

const CreateSchema = z.object({
  name: z.string().min(1).max(64).optional(),
  backend: BackendSchema.optional(),
  image: z.string().max(128).optional(),
  fileAccess: FileAccessSchema.optional(),
})

const UpdateSchema = z.object({
  id: z.string().min(1).max(20),
  name: z.string().min(1).max(64).optional(),
  image: z.string().max(128).nullable().optional(),
  fileAccess: FileAccessSchema.optional(),
})

/**
 * 工作区控制面（`/ai-workspace/*`）：后台管理员鉴权、全 POST、无路径参数。
 *
 * 只做 HTTP 边界：CRUD 与启停交给 service；`ai_workspaces` 的写方是这里。
 */
@Controller('ai-workspace')
@UseGuards(AdminAuthGuard)
export class WorkspaceAdminController {
  constructor(@Inject(WorkspaceAdminService) private readonly service: WorkspaceAdminService) {}

  private owner(): string {
    return String(requestContext.get('adminId') ?? '')
  }

  @Post('list')
  @HttpCode(200)
  list() {
    return this.service.list(this.owner())
  }

  @Post('create')
  @HttpCode(200)
  create(@Body({ schema: CreateSchema }) body: z.infer<typeof CreateSchema>) {
    return this.service.create(this.owner(), body)
  }

  @Post('update')
  @HttpCode(200)
  update(@Body({ schema: UpdateSchema }) body: z.infer<typeof UpdateSchema>) {
    const { id, ...input } = body
    return this.service.update(this.owner(), id, input)
  }

  @Post('remove')
  @HttpCode(200)
  remove(@Body({ schema: IdSchema }) body: z.infer<typeof IdSchema>) {
    return this.service.remove(this.owner(), body.id)
  }

  @Post('start')
  @HttpCode(200)
  start(@Body({ schema: IdSchema }) body: z.infer<typeof IdSchema>) {
    return this.service.start(this.owner(), body.id)
  }

  @Post('stop')
  @HttpCode(200)
  stop(@Body({ schema: IdSchema }) body: z.infer<typeof IdSchema>) {
    return this.service.stop(this.owner(), body.id)
  }
}
