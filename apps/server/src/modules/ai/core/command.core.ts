import { isAbsolute, relative, resolve } from 'node:path'
import { Inject, Injectable } from '@nestjs/common'
import { createTool } from '@mastra/core/tools'
import type { RequestContext } from '@mastra/core/request-context'
import { z } from 'zod'
import { AppLogger, CommandRunner, resolveShell, type CommandResult } from '@repo/kits'
import { TOOL_KEYS } from '../tools/tool-keys.js'
import type { AgentTool, AgentToolInstance } from '../tools/tools.types.js'
import { AgentConfig, type AgentConfig as AgentConfigValue } from './ai.config.js'
import { readAgentRuntime, type AgentCore } from './ai.core.types.js'

/**
 * `run-command` 的入参契约（**给模型看的契约**）。
 *
 * 三个字段刻意保持极简：命令、在哪个目录跑、最多跑多久。
 * 上限（时长 / 输出）由**服务端策略**再夹一次（`agent.command*`），模型传什么都不越界。
 */
const RunCommandInputSchema = z.object({
  command: z
    .string()
    .min(1)
    .max(2000)
    .describe(
      '要执行的**整条命令行**，按当前操作系统的 shell 语法书写' +
        '（Windows 是 cmd.exe：`dir`；Linux/macOS 是 /bin/sh：`ls -la`）。' +
        '不支持需要持续输入的交互式命令（没有 stdin）。',
    ),
  cwd: z
    .string()
    .min(1)
    .max(512)
    .optional()
    .describe('工作目录（相对默认工作目录，或它的子目录的绝对路径）；省略即用默认工作目录。**不允许跑到工作目录之外**'),
  timeout_ms: z
    .number()
    .int()
    .positive()
    .max(120_000)
    .optional()
    .describe('这次命令最多等多久（毫秒）；省略用服务端默认值（超过服务端上限会被夹到上限）'),
})

/** Mastra 工具执行上下文的最小面（与 `planner.core.ts` 同一手法：只取用到的几项） */
interface ToolContextLike {
  requestContext?: RequestContext
  abortSignal?: AbortSignal
}

/**
 * **命令执行能力**（core bean）：提供 `run-command` —— agent 用它在本机跑一条命令并拿到结论。
 *
 * 为什么是 core bean：它不属于任何业务模块（不查业务表、不调业务 service），
 * 而是与「规划」「子 agent」同层的**运行时能力**；机制在基础设施门面
 * （`@repo/kits` 的 `CommandRunner`，底层 execa），本类只做**策略与收窄**：
 *
 * 1. **开关**：`agent.commandEnabled=false` 时工具照旧在（装配期必须交出工具），
 *    但每次调用返回"已被关闭"的结论 —— 模型能理解并改口，而不是遇到一个不存在的工具；
 * 2. **目录边界**：`cwd` 必须落在 `agent.commandWorkDir`（缺省 = 服务进程工作目录）之内，
 *    越界直接拒绝并说明边界（**不静默夹回**，否则模型不知道自己越界了）；
 * 3. **时长 / 输出上限**：从配置取默认与上限，逐次夹紧；
 * 4. **可中止**：用户点停止 → 运行时信封里的 `abortSignal` → 命令真被杀掉（不是只断前端连接）。
 *
 * 安全边界（**如实记录，不假装这是沙箱**）：这仍然是"让模型在本机执行命令"——
 * 命令以**服务进程的身份与权限**运行，能读写该身份能读写的一切。工程的取舍是：
 * 由 `agent.commandEnabled` 决定开不开、由 workdir 限制默认落点、由超时与输出上限兜住资源，
 * 并且**每一次调用都完整入库**（时间线里的工具入参出参就是审计证据）+ 一条 info 日志。
 * 真要强隔离，得把执行放到容器 / 沙箱里（那是另一件事，不在本类里假装做到）。
 */
@Injectable()
export class CommandCore implements AgentCore {
  /** core bean 的 key（诊断用） */
  readonly key = 'command'

  private readonly runCommand: AgentTool

  constructor(
    @Inject(CommandRunner) private readonly runner: CommandRunner,
    @Inject(AgentConfig) private readonly config: AgentConfigValue,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {
    const key = TOOL_KEYS.runCommand
    const description =
      '在本机执行一条命令行命令，拿到退出码、stdout 与 stderr。' +
      '适用：需要**真实执行**才能得到答案的事（看目录与文件、跑脚本或测试、查版本与环境、' +
      '做一次计算、取当前时间）。' +
      '命令要按**当前操作系统**的 shell 语法写 —— 系统指令里给了操作系统与 shell；' +
      '不确定现在几点、环境变了没有，也可以用它自己查。' +
      '不适用：需要持续输入的命令（没有 stdin）、必须长时间挂着不返回的服务（会被超时终止）、' +
      '以及可以从已有知识直接回答的问题（不必为了"看起来像在工作"而跑命令）。' +
      '失败（非零退出 / 超时 / 输出超限）会作为**结论**返回，你要读懂原因再决定下一步，别原样重试。'
    this.runCommand = {
      key,
      title: '执行命令行命令',
      description,
      tool: createTool({
        id: key,
        description,
        inputSchema: RunCommandInputSchema,
        execute: async (input, context) => {
          const runtime = context as unknown as ToolContextLike
          const envelope = readAgentRuntime(runtime?.requestContext)
          const workDir = resolve(this.config.commandWorkDir ?? process.cwd())

          // 开关：能力被关掉时给一句能理解的结论（而不是抛错，更不是静默失效）
          if (!this.config.commandEnabled) {
            this.logger.warn('ai.command.disabled', { command: input.command })
            return this.rejected(input.command, workDir, '命令执行能力已被管理员关闭（AGENT_COMMAND_ENABLED=false）')
          }

          const target = this.resolveWorkDir(input.cwd, workDir)
          if (!target.ok) {
            this.logger.warn('ai.command.cwd_rejected', { cwd: input.cwd, workDir })
            return this.rejected(input.command, workDir, target.reason)
          }

          const abortSignal = runtime?.abortSignal ?? envelope?.abortSignal

          const result = await this.runner.run({
            command: input.command,
            cwd: target.cwd,
            // 配置里的时长既是**默认值**也是**硬上限**：模型传更小就听它的，传更大一律夹到上限
            timeoutMs: Math.min(
              input.timeout_ms ?? this.config.commandTimeoutMs,
              this.config.commandTimeoutMs,
            ),
            maxOutputBytes: this.config.commandMaxOutputBytes,
            // 用户停止 / 这一轮结束：命令必须真被杀掉（信封与工具上下文都可带，取先有的那个）
            ...(abortSignal ? { signal: abortSignal } : {}),
          })

          // 每次执行都留一条审计线索（完整入参出参另有时间线兜底）
          this.logger.info('ai.command.executed', {
            conversationId: envelope?.conversationId,
            runId: envelope?.parentRunId,
            userId: envelope?.triggeredBy,
            command: input.command,
            cwd: result.cwd,
            exitCode: result.exitCode,
            ok: result.ok,
            timedOut: result.timedOut,
            aborted: result.aborted,
            truncated: result.truncated,
            durationMs: result.durationMs,
          })

          // 出参**原样返回**（运行时会把完整出参落时间线，不裁剪）
          return result
        },
      }) as AgentToolInstance,
    }
  }

  asTools(): readonly AgentTool[] {
    return [this.runCommand]
  }

  /**
   * 解析工作目录：必须是工作根目录**之内**的路径。
   *
   * 用 `path.relative` 判边界而不是字符串前缀：既天然处理 `..` 逃逸，
   * 也不会被 Windows 的大小写差异（`C:\Users` vs `c:\users`）误判。
   */
  private resolveWorkDir(
    requested: string | undefined,
    workDir: string,
  ): { ok: true; cwd: string } | { ok: false; reason: string } {
    if (!requested) return { ok: true, cwd: workDir }
    const target = resolve(workDir, requested)
    const rel = relative(workDir, target)
    const inside = rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
    if (!inside) {
      return {
        ok: false,
        reason: `工作目录只能在工作根目录之内（${workDir}），收到的是 ${requested}`,
      }
    }
    return { ok: true, cwd: target }
  }

  /** 没跑命令就拒绝时的结论：形状与真实结果一致（调用方 / 落库 / 前端渲染都不用分支） */
  private rejected(command: string, cwd: string, reason: string): CommandResult {
    return {
      ok: false,
      command,
      shell: resolveShell(),
      cwd,
      exitCode: null,
      stdout: '',
      stderr: '',
      timedOut: false,
      aborted: false,
      truncated: false,
      durationMs: 0,
      reason,
    }
  }
}
