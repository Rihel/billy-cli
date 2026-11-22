import { Body, Controller, HttpCode, Inject, Post, UseGuards } from '@nestjs/common'
import { z } from 'zod'
import { AdminAuthGuard } from '../../admin/admin-auth.guard.js'
import { currentOwner, type OwnerRef } from '../../../common/security/index.js'
import { WorkspaceAdminService } from './workspace.service.js'

const IdSchema = z.object({ id: z.string().min(1).max(20) })
/** 与 shared 的 `WorkspaceFileReadSchema` 同口径：归属 + 工作区内路径 */
const FileReadSchema = z.object({
  id: z.string().min(1).max(20),
  path: z.string().min(1).max(512),
})
const BackendSchema = z.enum(['local', 'container', 'microvm'])
const FileAccessSchema = z.enum(['read-only', 'write'])

const CreateSchema = z.object({
  name: z.string().min(1).max(64).optional(),
  backend: BackendSchema.optional(),
  image: z.string().max(128).optional(),
  driver: z.enum(['host', 'container', 'pod']).optional(),
  root: z.string().min(1).max(512).optional(),
  fileAccess: FileAccessSchema.optional(),
})

const UpdateSchema = z.object({
  id: z.string().min(1).max(20),
  name: z.string().min(1).max(64).optional(),
  image: z.string().max(128).nullable().optional(),
  driver: z.enum(['host', 'container', 'pod']).nullable().optional(),
  root: z.string().max(512).nullable().optional(),
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

  /** 归属由身份推导（用户端不经过这个控制器，这里必然是管理员） */
  private owner(): OwnerRef {
    return currentOwner()
  }

  /** 新建工作区会落在哪（后端 / 驱动 / 位置说明）：界面只展示，不让用户选 */
  @Post('defaults')
  @HttpCode(200)
  defaults() {
    return this.service.defaults()
  }

  /** 部署级信息（平台 / 沙箱 / 容器运行时）：后台据此提示「当前部署没有沙箱」 */
  @Post('server-info')
  @HttpCode(200)
  serverInfo() {
    return this.service.serverInfo()
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

  /** 只读文件树：后台工作区卡片上的「文件」弹窗（未运行会明确报错） */
  @Post('files')
  @HttpCode(200)
  files(@Body({ schema: IdSchema }) body: z.infer<typeof IdSchema>) {
    return this.service.files(this.owner(), body.id)
  }

  /** 读单个文件正文（文本预览，> 512KB 拒绝） */
  @Post('file/read')
  @HttpCode(200)
  readFile(@Body({ schema: FileReadSchema }) body: z.infer<typeof FileReadSchema>) {
    return this.service.readFile(this.owner(), body.id, body.path)
  }

  /** 下载单个文件（base64，> 8MB 拒绝） */
  @Post('file/download')
  @HttpCode(200)
  downloadFile(@Body({ schema: FileReadSchema }) body: z.infer<typeof FileReadSchema>) {
    return this.service.downloadFile(this.owner(), body.id, body.path)
  }
}
