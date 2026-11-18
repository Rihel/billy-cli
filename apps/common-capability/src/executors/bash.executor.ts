import { mkdir } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import { Inject, Injectable } from '@nestjs/common'
import { z } from 'zod'
import { AppLogger, WorkspaceRuntimeService } from '@repo/kits'
import { CapabilityDecl, CapabilityGroup, findCapabilityDecl } from '@repo/capability'
import type { ToolInvokeRequest, ToolOutcome } from '@repo/contracts'
import { ToolWorkerConfig, type ToolWorkerConfigValue } from '../config/app-config.js'

const SAFE_ID = /^[\p{L}\p{N}._-]{1,128}$/u

const inside = (root: string, target: string): boolean => {
  const rel = relative(root, target)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** 声明里那份 zod 解析出来的形状（机制包宽类型丢了推导，这里补一处结构断言） */
interface BashInput {
  command: string
  cwd?: string
}

/** bash 执行器：工作区在本地临时目录（可丢弃），隔离由 WorkspaceRuntimeService 负责 */
@Injectable()
@CapabilityGroup({ risk: 'write' })
export class BashExecutor {
  constructor(
    @Inject(WorkspaceRuntimeService) private readonly runtime: WorkspaceRuntimeService,
    @Inject(ToolWorkerConfig) private readonly config: ToolWorkerConfigValue,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}

  @CapabilityDecl({
    tool: 'bash',
    title: '执行 bash 命令',
    description:
      '在沙箱里执行一条命令，返回退出码、stdout 与 stderr。命令要幂等，输出尽量用管道收窄。',
    input: z.object({
      command: z
        .string()
        .min(1)
        .max(2_000)
        .describe(
          '要执行的整条命令行，按当前操作系统 shell 的语法书写；不支持需要持续输入的交互式命令',
        ),
      cwd: z
        .string()
        .min(1)
        .max(512)
        .optional()
        .describe('工作目录（相对默认工作目录，或它的子目录）；不允许跑到工作目录之外'),
    }),
    timeoutMs: 300_000,
    execution: {
      mode: 'task',
      owner: 'session',
      yieldMs: 45_000,
      wait: { maxWaitMs: 60_000 },
      cancel: 'supported',
      maxRunMs: 1_800_000,
    },
  })
  async bash(request: ToolInvokeRequest): Promise<ToolOutcome> {
    // 与登记同一份入参：声明里改了字段，这里自动跟上
    const parsed = findCapabilityDecl(this, 'bash').input.safeParse(request.input)
    if (!parsed.success) {
      return {
        ok: false,
        reason: 'invalid-input',
        message: `命令参数不合法：${parsed.error.issues[0]?.message ?? '未知错误'}`,
        retryable: false,
      }
    }
    const input = parsed.data as BashInput
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
        toolKey: 'bash',
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
        toolKey: 'bash',
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
