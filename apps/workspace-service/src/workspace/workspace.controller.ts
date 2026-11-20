import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  HttpCode,
  Inject,
  Post,
  UseFilters,
} from '@nestjs/common'
import { AppExceptionFilter } from '@repo/kits'
import {
  WorkspaceExecRequestSchema,
  WorkspaceFsRequestSchema,
  WorkspaceIdRequestSchema,
  WorkspaceSyncRequestSchema,
} from '@repo/contracts'
import { WorkspaceServiceConfig, type WorkspaceServiceConfigValue } from '../config/app-config.js'
import { WorkspaceRuntime } from './workspace-runtime.service.js'

/**
 * workspace-service 的内部 API（只给 main / 能力网关调用）。
 *
 * 不暴露用户面；鉴权只靠内部令牌。业务失败也是 HTTP 200 + `ok:false`，与能力协议一致。
 */
@Controller()
@UseFilters(AppExceptionFilter)
export class WorkspaceController {
  constructor(
    @Inject(WorkspaceRuntime) private readonly runtime: WorkspaceRuntime,
    @Inject(WorkspaceServiceConfig) private readonly config: WorkspaceServiceConfigValue,
  ) {}

  private check(token: string | undefined): void {
    if (token !== this.config.internalToken) {
      throw new ForbiddenException('内部令牌不正确')
    }
  }

  @Get('healthz')
  health(): { ok: boolean } {
    return { ok: true }
  }

  @Get('readyz')
  ready(): { ok: boolean } {
    return { ok: true }
  }

  @Post('v1/workspaces/ensure')
  @HttpCode(200)
  ensure(@Headers('x-internal-token') token: string | undefined, @Body() body: unknown) {
    this.check(token)
    const input = WorkspaceIdRequestSchema.parse(body)
    return this.runtime.ensure(input.workspaceId)
  }

  @Post('v1/workspaces/stop')
  @HttpCode(200)
  stop(@Headers('x-internal-token') token: string | undefined, @Body() body: unknown) {
    this.check(token)
    const input = WorkspaceIdRequestSchema.parse(body)
    return this.runtime.stop(input.workspaceId)
  }

  @Post('v1/workspaces/destroy')
  @HttpCode(200)
  destroy(@Headers('x-internal-token') token: string | undefined, @Body() body: unknown) {
    this.check(token)
    const input = WorkspaceIdRequestSchema.parse(body)
    return this.runtime.destroy(input.workspaceId)
  }

  @Post('v1/workspaces/status')
  @HttpCode(200)
  status(@Headers('x-internal-token') token: string | undefined, @Body() body: unknown) {
    this.check(token)
    const input = WorkspaceIdRequestSchema.parse(body)
    return this.runtime.status(input.workspaceId)
  }

  /** 凭据同步：只对**已在运行**的工作区生效，不拉起容器 */
  @Post('v1/workspaces/sync')
  @HttpCode(200)
  async sync(@Headers('x-internal-token') token: string | undefined, @Body() body: unknown) {
    this.check(token)
    const input = WorkspaceSyncRequestSchema.parse(body)
    return this.runtime.syncCredentials(input.workspaceId, input.credentialVersion, {
      skills: input.skills === true,
    })
  }

  @Post('v1/workspaces/exec')
  @HttpCode(200)
  exec(@Headers('x-internal-token') token: string | undefined, @Body() body: unknown) {
    this.check(token)
    const input = WorkspaceExecRequestSchema.parse(body)
    return this.runtime.exec(input.workspaceId, input)
  }

  @Post('v1/workspaces/fs')
  @HttpCode(200)
  fs(@Headers('x-internal-token') token: string | undefined, @Body() body: unknown) {
    this.check(token)
    const input = WorkspaceFsRequestSchema.parse(body)
    return this.runtime.fs(input.workspaceId, input)
  }
}
