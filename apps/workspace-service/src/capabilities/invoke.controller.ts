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
import { randomUUID } from 'node:crypto'
import { scanCapabilities, type CapabilityDefinition } from '@repo/capability'
import { AppExceptionFilter } from '@repo/kits'
import { z } from 'zod'
import type { ToolInvokeRequest, ToolOutcome } from '@repo/contracts'
import { BashExecutor } from './bash.executor.js'
import { WorkspaceTaskManager } from './task.manager.js'
import { FileExecutor } from './file.executor.js'
import { CredentialCandidatesExecutor, CredentialImportExecutor } from './credential.executor.js'
import { CredentialSaveExecutor } from './credential-save.executor.js'
import { WorkspaceServiceConfig, type WorkspaceServiceConfigValue } from '../config/app-config.js'

/** 网关 → 服务 的调用体（服务侧协议：`tool` 而不是 `capability`） */
const InvokeBodySchema = z.object({
  version: z.literal(1).default(1),
  requestId: z.string().min(1).max(128).optional(),
  tool: z.string().min(1).max(64),
  workspaceId: z.string().min(1).max(20).optional(),
  input: z.record(z.string(), z.unknown()).default({}),
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

interface DispatchedCapability {
  decl: CapabilityDefinition
  invoke: (request: ToolInvokeRequest) => Promise<ToolOutcome>
}

/**
 * **分发面与登记面同源**：逐个执行器扫描 `@CapabilityDecl`，按 tool 名建索引。
 *
 * 以前这里是手写的 tool → handler 映射，新增能力时只改了登记面（`capability.registration.ts`）
 * 忘了这里，「登记了但调不通」会静默存在（issue 5：credential 工具全部 unsupported-tool）。
 * 现在登记与分发读的是同一份声明，加一个能力只需要加一个带声明的方法。
 */
export const indexCapabilities = (
  executors: readonly object[],
): Map<string, DispatchedCapability> => {
  const byTool = new Map<string, DispatchedCapability>()
  for (const executor of executors) {
    for (const { method, decl } of scanCapabilities(executor)) {
      const handler = (executor as Record<string, unknown>)[method] as unknown as (
        request: ToolInvokeRequest,
      ) => Promise<ToolOutcome>
      byTool.set(decl.tool, { decl, invoke: (request) => handler.call(executor, request) })
    }
  }
  return byTool
}

/**
 * 能力协议的 `/invoke` 入口（网关调用）。
 *
 * 路由规则只有一条：工具名 → 声明；声明是 `execution.mode='task'` 的走任务形态
 * （先受理、上游轮询 `/tasks/get`），其余直接等结果。
 */
@Controller()
@UseFilters(AppExceptionFilter)
export class WorkspaceInvokeController {
  private readonly byTool: ReadonlyMap<string, DispatchedCapability>

  constructor(
    @Inject(BashExecutor) private readonly bash: BashExecutor,
    @Inject(FileExecutor) private readonly file: FileExecutor,
    @Inject(WorkspaceTaskManager) private readonly tasks: WorkspaceTaskManager,
    @Inject(CredentialCandidatesExecutor)
    private readonly credentialCandidates: CredentialCandidatesExecutor,
    @Inject(CredentialImportExecutor) private readonly credentialImport: CredentialImportExecutor,
    @Inject(CredentialSaveExecutor) private readonly credentialSave: CredentialSaveExecutor,
    @Inject(WorkspaceServiceConfig) private readonly config: WorkspaceServiceConfigValue,
  ) {
    this.byTool = indexCapabilities([
      this.bash,
      this.file,
      this.credentialCandidates,
      this.credentialImport,
      this.credentialSave,
    ])
  }

  @Post('invoke')
  @HttpCode(200)
  async invoke(
    @Headers('x-internal-token') token: string | undefined,
    @Body() body: unknown,
  ): Promise<unknown> {
    if (token !== this.config.internalToken && token !== this.config.gatewayToken) {
      throw new ForbiddenException('内部令牌不正确')
    }
    const parsed = InvokeBodySchema.safeParse(body)
    if (!parsed.success) {
      return {
        version: 1,
        ok: false,
        reason: 'invalid-input',
        message: `请求体不合法：${parsed.error.issues[0]?.message ?? '未知错误'}`,
        retryable: false,
      }
    }
    const input = parsed.data
    const converted: ToolInvokeRequest = {
      version: 1 as const,
      requestId: input.requestId ?? randomUUID(),
      toolKey: input.tool,
      toolCallId: input.idempotencyKey ?? null,
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      input: input.input,
      caller: input.caller,
      deadlineMs: input.deadlineMs,
    }
    const capability = this.byTool.get(input.tool)
    if (!capability) {
      return {
        version: 1,
        ok: false,
        reason: 'unsupported-tool',
        message: `workspace 服务不支持能力 ${input.tool}`,
        retryable: false,
      }
    }

    // 长命令走 task 形态：先受理再让上游轮询 `/tasks/get`
    if (capability.decl.execution?.mode === 'task') {
      const snapshot = await this.tasks.start(
        converted,
        capability.decl.execution?.yieldMs ?? 45_000,
      )
      if (snapshot.state === 'running') {
        return {
          version: 1,
          ok: true,
          task: {
            id: snapshot.id,
            state: 'running',
            ...(snapshot.data === undefined ? {} : { data: snapshot.data }),
          },
        }
      }
      if (snapshot.state === 'succeeded') {
        return { version: 1, ok: true, data: snapshot.result?.data }
      }
      return {
        version: 1,
        ok: false,
        reason: snapshot.error?.reason ?? 'task-failed',
        message: snapshot.error?.message ?? '任务失败',
        // 暂态 / 永久语义必须全链路透传：执行器说可重试，这里不能咽掉（issue 11）
        retryable: snapshot.error?.retryable ?? false,
      }
    }

    // 服务响应契约：{ version, ok, data | reason/message }
    const outcome = await capability.invoke(converted)
    return { version: 1, ...outcome }
  }
}
