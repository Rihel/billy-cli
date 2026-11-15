import { mkdir } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import { Inject, Injectable } from '@nestjs/common'
import { AppLogger, WorkspaceRuntimeService } from '@repo/kits'
import { BASH_TOOL } from '@repo/tool-catalog'
import type { ToolInvokeRequest, ToolOutcome } from '@repo/contracts'
import { ToolWorkerConfig, type ToolWorkerConfigValue } from '../config/app-config.js'
import type { ToolExecutor } from './tool.executor.js'

const SAFE_ID = /^[\p{L}\p{N}._-]{1,128}$/u

const inside = (root: string, target: string): boolean => {
  const rel = relative(root, target)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** bash 执行器：工作区在本地临时目录（可丢弃），隔离由 WorkspaceRuntimeService 负责 */
@Injectable()
export class BashExecutor implements ToolExecutor {
  readonly key = 'bash'

  constructor(
    @Inject(WorkspaceRuntimeService) private readonly runtime: WorkspaceRuntimeService,
    @Inject(ToolWorkerConfig) private readonly config: ToolWorkerConfigValue,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}

  async execute(request: ToolInvokeRequest): Promise<ToolOutcome> {
    const parsed = BASH_TOOL.params.safeParse(request.input)
    if (!parsed.success) {
      return {
        ok: false,
        reason: 'invalid-input',
        message: `命令参数不合法：${parsed.error.issues[0]?.message ?? '未知错误'}`,
        retryable: false,
      }
    }
    const input = parsed.data
    const conversationId = request.caller.conversationId
    // 子会话共享父工作区；没有显式 workspace id 时就是当前会话
    const workspaceConversationId = request.workspaceConversationId ?? conversationId
    if (!SAFE_ID.test(conversationId) || !SAFE_ID.test(workspaceConversationId)) {
      return {
        ok: false,
        reason: 'invalid-input',
        message: '会话 id 不合法',
        retryable: false,
      }
    }

    const workspaceRoot = resolve(this.config.workspaceRoot, workspaceConversationId)
    const cwd = resolve(workspaceRoot, input.cwd ?? '.')
    if (!inside(workspaceRoot, cwd)) {
      return {
        ok: false,
        reason: 'invalid-input',
        message: '工作目录必须在本会话工作区之内',
        retryable: false,
      }
    }

    try {
      await mkdir(cwd, { recursive: true })
      const remaining = Math.max(1, request.deadlineMs - 500)
      // 命令时长只由部署配置决定（模型入参里没有时长）；同时不超过这次调用的剩余预算
      const timeoutMs = Math.min(this.config.commandTimeoutMs, remaining)
      const startedAt = Date.now()
      const result = await this.runtime.exec({
        command: input.command,
        cwd,
        workspaceRoot,
        fileAccess: request.fileAccess ?? 'workspace-write',
        timeoutMs,
        maxOutputBytes: this.config.maxOutputBytes,
      })
      this.logger.info('tool_worker.executed', {
        workerId: this.config.id,
        requestId: request.requestId,
        runId: request.caller.runId,
        conversationId,
        toolKey: this.key,
        command: input.command,
        exitCode: result.exitCode,
        ok: result.ok,
        runtime: result.runtime,
        mode: result.mode,
        durationMs: Date.now() - startedAt,
      })
      return { ok: true, data: result }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      this.logger.error('tool_worker.exec_failed', {
        requestId: request.requestId,
        runId: request.caller.runId,
        toolKey: this.key,
        reason,
      })
      return {
        ok: false,
        reason: 'exec-failed',
        message: `工具执行失败：${reason}`,
        retryable: true,
      }
    }
  }
}
