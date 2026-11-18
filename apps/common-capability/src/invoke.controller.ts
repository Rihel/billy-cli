import { randomUUID } from 'node:crypto'
import {
  BadRequestException,
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
import {
  TOOL_CONTRACT_VERSION,
  ToolRuntimeSettingsSchema,
  type ToolInvokeRequest,
  type ToolRuntimeSettings,
} from '@repo/contracts'
import { z } from 'zod'
import { ToolWorkerConfig, type ToolWorkerConfigValue } from './config/app-config.js'
import { TaskManager } from './task.manager.js'
import { ToolWorkerService } from './worker.service.js'
import { ToolExecutorRegistry } from './executors/executor.registry.js'

/**
 * 能力协议的 `/invoke` 入口（见 `docs/design/capability-protocol.md` §7）。
 *
 * 与旧 `POST /v1/exec` 的区别：
 * - body 是协议形状（`tool` 而不是 `toolKey`，`reason` 在顶层）；
 * - **工具名不带 namespace**：网关已经拆好了，服务只认工具名；
 * - 返回三形态之一（完成 / 受理 / 业务失败），业务失败也是 HTTP 200。
 */
const InvokeBodySchema = z.object({
  version: z.literal(1),
  requestId: z.string().min(1).max(128).optional(),
  tool: z.string().min(1).max(64),
  input: z.record(z.string(), z.unknown()).default({}),
  reason: z.string().max(2_000).optional(),
  caller: z.object({
    conversationId: z.string().min(1),
    runId: z.string().min(1),
    userId: z.string().nullable().optional(),
    isAdmin: z.boolean().optional(),
    agentKey: z.string().min(1),
    rootAgentKey: z.string().min(1),
    depth: z.number().int().nonnegative(),
  }),
  deadlineMs: z.number().int().positive().max(360_000).default(30_000),
  idempotencyKey: z.string().max(128).optional(),
})

/** 一次同步等待的上限（协议 §6：`yieldMs` 默认 45 秒） */
const YIELD_MS = 45_000

const TaskQuerySchema = z.object({
  taskId: z.string().min(1).max(128),
  waitMs: z.number().int().positive().max(120_000).optional(),
})

const TaskCancelSchema = z.object({ taskId: z.string().min(1).max(128) })

/**
 * 网关下发的工具级配置（`x-capability-config`）：ASCII JSON，或 `b64:` + base64url(JSON)。
 *
 * 解析失败按「没有配置」处理（不拦调用）：服务的部署默认值仍然可用。
 */
const decodeSettings = (raw: string | undefined): ToolRuntimeSettings | undefined => {
  if (!raw) return undefined
  try {
    const json = raw.startsWith('b64:')
      ? Buffer.from(raw.slice(4), 'base64url').toString('utf8')
      : raw
    const parsed = ToolRuntimeSettingsSchema.safeParse(JSON.parse(json))
    return parsed.success ? parsed.data : undefined
  } catch {
    return undefined
  }
}

@Controller()
@UseFilters(AppExceptionFilter)
export class CapabilityInvokeController {
  constructor(
    @Inject(ToolWorkerService) private readonly service: ToolWorkerService,
    @Inject(TaskManager) private readonly tasks: TaskManager,
    @Inject(ToolWorkerConfig) private readonly config: ToolWorkerConfigValue,
    @Inject(ToolExecutorRegistry) private readonly executors: ToolExecutorRegistry,
  ) {}

  @Post('invoke')
  @HttpCode(200)
  async invoke(
    @Headers('x-internal-token') token: string | undefined,
    @Headers('x-capability-key') capabilityKey: string | undefined,
    @Headers('x-capability-config') settingsHeader: string | undefined,
    @Body() body: unknown,
  ): Promise<Record<string, unknown>> {
    if (token !== this.config.internalToken) {
      throw new ForbiddenException('内部令牌不匹配')
    }
    const parsed = InvokeBodySchema.safeParse(body)
    if (!parsed.success) {
      throw new BadRequestException(
        `能力调用请求不合法：${parsed.error.issues[0]?.message ?? '未知错误'}`,
      )
    }
    const input = parsed.data
    // 规范 key 由网关带过来（`web/search`）：执行器注册的就是它，直接分发
    if (!capabilityKey || !this.executors.get(capabilityKey)) {
      return {
        version: 1,
        ok: false,
        reason: 'unknown-tool',
        message: `本服务没有这个能力：${capabilityKey ?? input.tool}`,
      }
    }
    const toolKey = capabilityKey

    const settings = decodeSettings(settingsHeader)
    const request: ToolInvokeRequest = {
      version: TOOL_CONTRACT_VERSION,
      requestId: input.requestId ?? randomUUID(),
      toolKey,
      toolCallId: null,
      input: input.input,
      caller: {
        conversationId: input.caller.conversationId,
        runId: input.caller.runId,
        userId: input.caller.userId ?? null,
        isAdmin: input.caller.isAdmin,
        agentKey: input.caller.agentKey,
        rootAgentKey: input.caller.rootAgentKey,
        depth: input.caller.depth,
      } as ToolInvokeRequest['caller'],
      deadlineMs: input.deadlineMs,
      ...(settings === undefined ? {} : { settings }),
    }

    // 任务形态取自能力声明（`execution.mode === 'task'`），不另维护一份 key 列表
    if (this.executors.isTaskTool(toolKey)) {
      // 任务执行预算 = 声明的 maxRunMs（协议 §13）：`deadlineMs` 只约束本次 HTTP 的等待窗口，
      // 不该把还在跑的命令提前杀掉（否则调用方传个小 deadline 就把任务毁了）。
      const taskRequest: ToolInvokeRequest = {
        ...request,
        deadlineMs: this.executors.maxRunMs(toolKey),
      }
      const snapshot = await this.tasks.start(
        taskRequest,
        Math.max(1_000, Math.min(YIELD_MS, input.deadlineMs - 1_000)),
      )
      if (snapshot.state === 'succeeded') {
        return { version: 1, ok: true, data: snapshot.result?.data ?? null }
      }
      if (snapshot.state === 'failed') {
        return {
          version: 1,
          ok: false,
          reason: snapshot.error?.reason ?? 'task-failed',
          message: snapshot.error?.message ?? '任务执行失败',
        }
      }
      return {
        version: 1,
        ok: true,
        task: { id: snapshot.id, state: snapshot.state, pollAfterMs: 2_000 },
      }
    }

    const outcome = await this.service.execute(request)
    return outcome.ok
      ? { version: 1, ok: true, data: outcome.data }
      : {
          version: 1,
          ok: false,
          reason: outcome.reason,
          message: outcome.message,
          ...(outcome.hint === undefined ? {} : { hint: outcome.hint }),
          ...(outcome.retryable === undefined ? {} : { retryable: outcome.retryable }),
        }
  }

  @Post('tasks/get')
  @HttpCode(200)
  async getTask(
    @Headers('x-internal-token') token: string | undefined,
    @Body() body: unknown,
  ): Promise<unknown> {
    if (token !== this.config.internalToken) throw new ForbiddenException('内部令牌不匹配')
    const parsed = TaskQuerySchema.safeParse(body)
    if (!parsed.success) throw new BadRequestException('任务查询请求不合法')
    return this.tasks.get(parsed.data.taskId, parsed.data.waitMs ?? 0)
  }

  @Post('tasks/cancel')
  @HttpCode(200)
  async cancelTask(
    @Headers('x-internal-token') token: string | undefined,
    @Body() body: unknown,
  ): Promise<unknown> {
    if (token !== this.config.internalToken) throw new ForbiddenException('内部令牌不匹配')
    const parsed = TaskCancelSchema.safeParse(body)
    if (!parsed.success) throw new BadRequestException('任务取消请求不合法')
    return this.tasks.cancel(parsed.data.taskId)
  }
}
