import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  HttpCode,
  Inject,
  Post,
  ServiceUnavailableException,
} from '@nestjs/common'
import { RedisStore, WorkspaceRuntimeService } from '@repo/kits'
import {
  TOOL_CONTRACT_VERSION,
  ToolInvokeRequestSchema,
  type ToolInvokeResponse,
} from '@repo/contracts'
import { ToolWorkerConfig, type ToolWorkerConfigValue } from './config/app-config.js'
import { ToolWorkerService } from './worker.service.js'
import { WorkerRegistry } from './worker.registry.js'

/**
 * worker 的内部 API（**只在私有网络**；不经过公网 Ingress）。
 *
 * `POST /v1/exec` 由 tool-gateway 调用；token 不对直接 403。
 * 行为上限 / 授权 / 限流不在这里做 —— worker 只负责「把这次执行做完」。
 */
@Controller()
export class ToolWorkerController {
  constructor(
    @Inject(ToolWorkerService) private readonly service: ToolWorkerService,
    @Inject(WorkerRegistry) private readonly registry: WorkerRegistry,
    @Inject(ToolWorkerConfig) private readonly config: ToolWorkerConfigValue,
    @Inject(RedisStore) private readonly redis: RedisStore,
    @Inject(WorkspaceRuntimeService) private readonly workspace: WorkspaceRuntimeService,
  ) {}

  @Post('v1/exec')
  @HttpCode(200)
  async exec(
    @Headers('x-internal-token') token: string | undefined,
    @Body() body: unknown,
  ): Promise<ToolInvokeResponse> {
    if (token !== this.config.internalToken) {
      throw new ForbiddenException('内部令牌不匹配')
    }
    const parsed = ToolInvokeRequestSchema.safeParse(body)
    if (!parsed.success) {
      throw new BadRequestException(
        `工具调用请求不合法：${parsed.error.issues[0]?.message ?? '未知错误'}`,
      )
    }
    const request = parsed.data
    const startedAt = Date.now()

    if (!this.registry.acquire()) {
      return {
        version: TOOL_CONTRACT_VERSION,
        requestId: request.requestId,
        workerId: this.config.id,
        durationMs: Date.now() - startedAt,
        outcome: {
          ok: false,
          reason: 'busy',
          message: 'worker 并发已满，请换一个 worker 重试',
          retryable: true,
        },
      }
    }

    try {
      const outcome = await this.service.execute(request)
      return {
        version: TOOL_CONTRACT_VERSION,
        requestId: request.requestId,
        workerId: this.config.id,
        durationMs: Date.now() - startedAt,
        outcome,
      }
    } finally {
      this.registry.release()
    }
  }

  /** liveness：只证明进程活着，不探外部依赖 */
  @Get('healthz')
  @HttpCode(200)
  healthz() {
    return {
      status: 'ok',
      workerId: this.config.id,
      uptimeSeconds: Math.round(process.uptime()),
    }
  }

  /** readiness：Redis（注册/租约）+ 沙箱可用性；enforce 下沙箱不可用即摘流 */
  @Get('readyz')
  @HttpCode(200)
  async readyz() {
    const status = await this.workspace.status().catch(() => null)
    const sandboxOk = status?.mode === 'off' || status?.sandbox.available === true
    if (!sandboxOk) {
      throw new ServiceUnavailableException('沙箱不可用，worker 未就绪')
    }
    try {
      await this.redis.ping()
    } catch {
      throw new ServiceUnavailableException('Redis 不可用，worker 未就绪')
    }
    return {
      status: 'ok',
      workerId: this.config.id,
      sandbox: status?.sandbox.available ?? false,
      mode: status?.mode ?? 'unknown',
    }
  }
}
