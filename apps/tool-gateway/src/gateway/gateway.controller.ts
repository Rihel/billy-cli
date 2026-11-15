import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Post,
  Res,
  UseGuards,
  UseFilters,
  UseInterceptors,
} from '@nestjs/common'
import { AppExceptionFilter, RedisStore, ResponseEnvelopeInterceptor } from '@repo/kits'
import {
  TOOL_CONTRACT_VERSION,
  ToolInvokeRequestSchema,
  ToolListRequestSchema,
  type ToolInvokeRequest,
  type ToolInvokeResponse,
  type ToolListRequest,
  type ToolListResponse,
  type WorkerRegistration,
} from '@repo/contracts'
import { ToolCatalogService } from '../catalog/tool.catalog.js'
import { ToolGatewayConfig, type ToolGatewayConfigValue } from '../config/app-config.js'
import { InternalTokenGuard } from '../http/internal-token.guard.js'
import { ZodBodyPipe } from '../http/zod-body.pipe.js'
import { ToolCallInterceptor } from '../policy/tool-call.interceptor.js'
import { WorkerDirectory } from '../workers/worker.directory.js'
import { ToolGatewayService } from './gateway.service.js'

/**
 * 工具网关入口（**只在私有网络**；由 facade 的 ToolInvoker 调用）。
 *
 * Nest 能力的分工：
 * - Guard：内部令牌（invoke / list / workers；healthz / readyz 开放给探针）；
 * - Pipe：请求体契约校验；
 * - Interceptor：工具调用结束统一写审计；
 * - Controller：只做转发，策略在 `ToolPolicyService`（域管道，需要按工具短路）。
 */
@Controller()
@UseFilters(AppExceptionFilter)
export class ToolGatewayController {
  constructor(
    @Inject(ToolGatewayService) private readonly service: ToolGatewayService,
    @Inject(ToolCatalogService) private readonly catalog: ToolCatalogService,
    @Inject(WorkerDirectory) private readonly directory: WorkerDirectory,
    @Inject(ToolGatewayConfig) private readonly config: ToolGatewayConfigValue,
    @Inject(RedisStore) private readonly redis: RedisStore,
  ) {}

  @Post('v1/tools/invoke')
  @HttpCode(200)
  @UseGuards(InternalTokenGuard)
  // 顺序有语义：信封在外层，审计（内层）才读得到 handler 的裸响应。
  // 反过来时 `ToolCallInterceptor` 的 tap 拿到的是 `{ code, data }`，读 `outcome` 直接 500。
  @UseInterceptors(ResponseEnvelopeInterceptor, ToolCallInterceptor)
  async invoke(
    @Body(new ZodBodyPipe(ToolInvokeRequestSchema)) request: ToolInvokeRequest,
  ): Promise<ToolInvokeResponse> {
    return this.service.invoke(request)
  }

  /** 工具面：facade / 模型从这里拿可用工具清单（按 caller / agent / 深度过滤） */
  @Post('v1/tools/list')
  @HttpCode(200)
  @UseGuards(InternalTokenGuard)
  @UseInterceptors(ResponseEnvelopeInterceptor)
  async listTools(
    @Body(new ZodBodyPipe(ToolListRequestSchema)) input: ToolListRequest,
  ): Promise<ToolListResponse> {
    return {
      version: TOOL_CONTRACT_VERSION,
      tools: await this.catalog.list(input),
    }
  }

  /** 调试 / 运维：当前注册表里看到的 worker（同目录 `pnpm dev:tool-worker` 起一个就能看到） */
  @Get('v1/workers')
  @HttpCode(200)
  @UseGuards(InternalTokenGuard)
  @UseInterceptors(ResponseEnvelopeInterceptor)
  async workers(): Promise<{ workers: WorkerRegistration[] }> {
    return { workers: await this.directory.list() }
  }

  @Get('healthz')
  @HttpCode(200)
  healthz() {
    return { status: 'ok', uptimeSeconds: Math.round(process.uptime()) }
  }

  /** readiness：进程 + Redis；worker 数量作为观测值返回，不因为 0 个 worker 摘掉网关 */
  @Get('readyz')
  @HttpCode(200)
  async readyz(@Res({ passthrough: true }) response: { status(code: number): void }) {
    let redisOk = true
    try {
      await this.redis.ping()
    } catch {
      redisOk = false
    }
    if (!redisOk) response.status(503)
    const workers = await this.directory.list().catch((): WorkerRegistration[] => [])
    return {
      status: redisOk ? 'ok' : 'degraded',
      redis: redisOk ? 'ok' : 'failed',
      workers: workers.filter((worker) => !worker.draining).length,
      staticWorker: Boolean(this.config.workerUrl),
    }
  }
}
