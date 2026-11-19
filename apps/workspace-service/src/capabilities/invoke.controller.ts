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
import { findCapabilityDecl } from '@repo/capability'
import { AppExceptionFilter } from '@repo/kits'
import { z } from 'zod'
import type { ToolOutcome } from '@repo/contracts'
import { BashExecutor } from './bash.executor.js'
import { WorkspaceTaskManager } from './task.manager.js'
import { FileExecutor } from './file.executor.js'
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

/**
 * 能力协议的 `/invoke` 入口（网关调用）。
 *
 * v1 只有 `bash` 一个能力；返回 `{ version, requestId, tool, outcome }`。
 */
@Controller()
@UseFilters(AppExceptionFilter)
export class WorkspaceInvokeController {
  constructor(
    @Inject(BashExecutor) private readonly bash: BashExecutor,
    @Inject(FileExecutor) private readonly file: FileExecutor,
    @Inject(WorkspaceTaskManager) private readonly tasks: WorkspaceTaskManager,
    @Inject(WorkspaceServiceConfig) private readonly config: WorkspaceServiceConfigValue,
  ) {}

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
    const converted = {
      version: 1 as const,
      requestId: input.requestId ?? randomUUID(),
      toolKey: input.tool,
      toolCallId: input.idempotencyKey ?? null,
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      input: input.input,
      caller: input.caller,
      deadlineMs: input.deadlineMs,
    }
    // file 的 fs 原语：直接分发给 FileExecutor
    const fileHandler = (
      {
        'file-list': () => this.file.fileList(converted),
        'read-file': () => this.file.readFile(converted),
        'write-file': () => this.file.writeFile(converted),
        'append-file': () => this.file.appendFile(converted),
        'replace-file': () => this.file.replaceFile(converted),
        'workspace-files': () => this.file.workspaceFiles(converted),
        'file-search': () => this.file.fileSearch(converted),
      } as Record<string, (() => Promise<ToolOutcome>) | undefined>
    )[input.tool]
    if (fileHandler) {
      const outcome = await fileHandler()
      return { version: 1, ...outcome }
    }
    if (input.tool !== 'bash') {
      return {
        version: 1,
        ok: false,
        reason: 'unsupported-tool',
        message: `workspace 服务不支持能力 ${input.tool}`,
        retryable: false,
      }
    }
    const decl = findCapabilityDecl(this.bash, 'bash')
    // 长命令走 task 形态：先受理再让上游轮询 `/tasks/get`
    if (decl.execution?.mode === 'task') {
      const snapshot = await this.tasks.start(converted, decl.execution?.yieldMs ?? 45_000)
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
        retryable: false,
      }
    }
    const outcome = await this.bash.bash(converted)
    // 服务响应契约：{ version, ok, data | reason/message }
    return { version: 1, ...outcome }
  }
}
