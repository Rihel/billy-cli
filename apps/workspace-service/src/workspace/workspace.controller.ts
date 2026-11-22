import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  HttpCode,
  Inject,
  Optional,
  Post,
  ServiceUnavailableException,
  UseFilters,
} from '@nestjs/common'
import { AppExceptionFilter, RedisStore } from '@repo/kits'
import {
  WorkspaceEnvironmentRequestSchema,
  WorkspaceExecRequestSchema,
  WorkspaceFsRequestSchema,
  WorkspaceIdRequestSchema,
  WorkspaceSyncRequestSchema,
} from '@repo/contracts'
import type { WorkspaceEnvironment } from '@repo/contracts'
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
    // 单副本不装配 Redis；多副本时 readiness 必须证明锁依赖可用
    @Optional() @Inject(RedisStore) private readonly redis?: RedisStore,
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
  async ready(): Promise<{ ok: boolean }> {
    if (!this.config.multiInstance) return { ok: true }
    try {
      await this.redis?.ping()
      if (!this.redis) throw new Error('RedisStore 未装配')
      return { ok: true }
    } catch {
      // 多副本下锁依赖不可用 = 不能安全执行；让网关 / k8s 把本 Pod 摘掉
      throw new ServiceUnavailableException('Redis 不可用，工作区执行面暂不可用')
    }
  }

  /** 部署级信息（平台 / 沙箱 / 容器运行时 / 目录配置）：排障与后台展示用 */
  @Get('info')
  info(): Promise<Record<string, unknown>> {
    return this.runtime.info()
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

  @Post('v1/workspaces/environment')
  @HttpCode(200)
  async environment(
    @Headers('x-internal-token') token: string | undefined,
    @Body() body: unknown,
  ): Promise<WorkspaceEnvironment> {
    this.check(token)
    const { workspaceId } = WorkspaceEnvironmentRequestSchema.parse(body)
    return this.runtime.environment(workspaceId)
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
