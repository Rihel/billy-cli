import { Inject, Injectable, type OnApplicationBootstrap } from '@nestjs/common'
import which from 'which'
import { AppLogger } from '../foundation/logger/app-logger.js'
import { CommandRunner } from '../foundation/command/command.runner.js'
import type { CommandResult } from '../foundation/command/command.runner.js'
import { resolveShell } from '../foundation/command/command.platform.js'
import { WORKSPACE_PROBE, WorkspaceConfig } from './workspace.config.js'
import type { WorkspaceConfigValue } from './workspace.config.js'
import { buildSandboxInvocation, probeSandbox } from './workspace.sandbox.js'
import type {
  SandboxCapability,
  SandboxMode,
  SandboxProbe,
  WorkspaceExecRequest,
  WorkspaceExecResult,
  WorkspaceFileAccess,
  WorkspaceReason,
  WorkspaceStatus,
} from './workspace.types.js'

/**
 * **工作区运行时**（基础设施能力）：把一条命令放进"文件效果"边界里执行。
 *
 * 两条口径（见 `docs/design/workspace-runtime.md`）：
 * 1. **终端用户只能选沙箱内的文件权限**（只读 / 可写），选不了"要不要沙箱"；
 * 2. **沙箱不可用就拒绝执行（fail closed）** —— 绝不悄悄退回"以服务进程身份跑"。
 *    Web 产品里那等于把服务器交给一个不可信的用户。
 *
 * 唯一的例外是部署显式配置 `AGENT_WORKSPACE_MODE=off`（自托管单租户）：此时整条执行
 * 降级为 `danger-full-access`，并在出参里如实标出来。
 */
@Injectable()
export class WorkspaceRuntimeService implements OnApplicationBootstrap {
  /** 探测结果按进程生命周期缓存（隔离能力不会在运行中变好） */
  private capability?: Promise<SandboxCapability>

  constructor(
    @Inject(WorkspaceConfig) private readonly config: WorkspaceConfigValue,
    @Inject(CommandRunner) private readonly runner: CommandRunner,
    @Inject(AppLogger) private readonly logger: AppLogger,
    @Inject(WORKSPACE_PROBE) private readonly probe: SandboxProbe,
  ) {}

  /** 启动即探测一次：把"这台机器能不能提供隔离"尽早写进日志 */
  async onApplicationBootstrap(): Promise<void> {
    const sandbox = await this.capabilities()
    this.logger.log('workspace.runtime.ready', {
      mode: this.config.mode,
      sandbox: sandbox.available,
      impl: sandbox.impl,
      reason: sandbox.reason?.code,
      network: this.config.sandboxNetwork,
    })
  }

  /** 沙箱能力（缓存；`force` 仅供测试与显式重探） */
  capabilities(force = false): Promise<SandboxCapability> {
    if (force) this.capability = undefined
    this.capability ??= this.detect()
    return this.capability
  }

  /** 当前部署的执行能力：管理页与 `/info` 直接展示这个 */
  async status(): Promise<WorkspaceStatus> {
    const sandbox = await this.capabilities()
    return {
      mode: this.config.mode,
      // `off` 时没有隔离，也就没有"文件权限"可谈
      fileAccessOptions:
        this.config.mode === 'off' ? [] : ['workspace-write', 'read-only'],
      sandbox,
    }
  }

  /**
   * 执行一条命令。**永不抛异常**：策略拒绝、沙箱不可用、沙箱构造失败都落成可读结论。
   */
  async exec(request: WorkspaceExecRequest): Promise<WorkspaceExecResult> {
    const mode = this.modeOf(request.fileAccess)
    if (mode === 'danger-full-access') {
      const result = await this.runner.run(request)
      return { ...result, runtime: 'local', mode }
    }

    const sandbox = await this.capabilities()
    if (!sandbox.available) {
      return this.blocked(request, mode, sandbox.reason ?? {
        code: 'sandbox-unavailable',
        message: '本部署未提供可用的命令隔离环境',
      })
    }
    return this.runSandbox(request, mode, sandbox)
  }

  /**
   * 会话选择 + 部署策略 → 实际模式。
   *
   * `off` 是唯一的"出沙箱"入口；`enforce` 下**只认两档允许值**，其它任何值
   * （伪造信封 / 越权请求）都落到 `workspace-write` —— 只往严处走，绝不执行 `danger-full-access`。
   */
  private modeOf(fileAccess: WorkspaceFileAccess | undefined): SandboxMode {
    if (this.config.mode === 'off') return 'danger-full-access'
    return fileAccess === 'read-only' ? 'read-only' : 'workspace-write'
  }

  /** 沙箱执行：包装成"只能读（或读写）工作区"的进程；出参回显原命令 */
  private async runSandbox(
    request: WorkspaceExecRequest,
    mode: SandboxMode,
    sandbox: SandboxCapability,
  ): Promise<WorkspaceExecResult> {
    const impl = sandbox.impl!
    const binary = sandbox.binary!
    const cwd = request.cwd ?? process.cwd()
    const workspaceRoot = request.workspaceRoot ?? cwd

    let invocation
    try {
      invocation = await buildSandboxInvocation({
        impl,
        binary,
        workspaceRoot,
        cwd,
        command: request.command,
        network: this.config.sandboxNetwork,
        mode,
      })
    } catch (error) {
      return this.blocked(request, mode, {
        code: 'exec-failed',
        message: `沙箱准备失败：${error instanceof Error ? error.message : String(error)}`,
      })
    }

    try {
      const result = await this.runner.run({
        ...request,
        command: invocation.command,
        cwd,
      })
      return {
        ...result,
        // 回显**模型给的那条命令**而不是包装后的；包装细节只进日志
        command: request.command,
        shell: '/bin/sh',
        runtime: 'sandbox',
        mode,
        impl,
      }
    } finally {
      await invocation.cleanup()
    }
  }

  /** 拒绝执行：不是异常，是一条"没跑"的结论 */
  private blocked(
    request: WorkspaceExecRequest,
    mode: SandboxMode,
    reason: WorkspaceReason,
  ): WorkspaceExecResult {
    this.logger.warn('workspace.runtime.rejected', {
      mode,
      code: reason.code,
      message: reason.message,
    })
    return {
      ok: false,
      command: request.command,
      shell: resolveShell(),
      cwd: request.cwd ?? process.cwd(),
      exitCode: null,
      stdout: '',
      stderr: '',
      timedOut: false,
      aborted: false,
      truncated: false,
      durationMs: 0,
      reason: reason.message,
      runtime: 'local',
      mode,
    }
  }

  /** 真实探测：注入命令执行与二进制查找，测试可整体替换 */
  private async detect(): Promise<SandboxCapability> {
    try {
      return await this.probe({
        platform: process.platform,
        run: (command, timeoutMs): Promise<CommandResult> =>
          this.runner.run({
            command,
            timeoutMs,
            maxOutputBytes: 8 * 1024,
          }),
        resolveBinary: (binary) => {
          try {
            return which.sync(binary)
          } catch {
            return null
          }
        },
        timeoutMs: this.config.probeTimeoutMs,
        network: this.config.sandboxNetwork,
      })
    } catch (error) {
      return {
        available: false,
        reason: {
          code: 'sandbox-unavailable',
          message: `沙箱探测异常：${error instanceof Error ? error.message : String(error)}`,
        },
        probedAt: new Date().toISOString(),
      }
    }
  }
}

/** 默认探测实现（模块 provider 用它；测试可换成桩） */
export const defaultSandboxProbe: SandboxProbe = probeSandbox
