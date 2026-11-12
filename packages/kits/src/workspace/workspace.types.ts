import type { CommandResult, CommandRunOptions } from '../foundation/command/command.runner.js'

/**
 * **沙箱模式**（内部词汇，对齐业界口径）：只描述"文件效果"，不描述网络与进程可见性。
 *
 * - `read-only`：不能改工作区（临时目录除外）；
 * - `workspace-write`：可以写本会话工作区（默认）；
 * - `danger-full-access`：不受限 —— 在本工程 = **以服务进程身份执行**。
 *
 * 前两档只能由会话选择；`danger-full-access` 是**部署级**能力（`AGENT_WORKSPACE_MODE=off`），
 * 终端用户永远选不到（web 产品的安全底线，见 `docs/design/workspace-runtime.md`）。
 */
export const SANDBOX_MODES = ['read-only', 'workspace-write', 'danger-full-access'] as const
export type SandboxMode = (typeof SANDBOX_MODES)[number]

/** 会话可选的**文件权限**：沙箱内的两档（不含 `danger-full-access`） */
export const WORKSPACE_FILE_ACCESS = ['read-only', 'workspace-write'] as const
export type WorkspaceFileAccess = (typeof WORKSPACE_FILE_ACCESS)[number]

/** 沙箱实现：macOS `sandbox-exec`（seatbelt）/ Linux `bwrap`（bubblewrap） */
export type SandboxImpl = 'seatbelt' | 'bwrap'

/** 失败理由码（给日志与断言，文案另给） */
export type WorkspaceReasonCode =
  /** 沙箱探测失败 / 不可用 —— **fail closed**，命令不执行 */
  | 'sandbox-unavailable'
  /** 沙箱二进制不存在 */
  | 'binary-missing'
  /** 二进制在，但用户命名空间被禁（容器里很常见） */
  | 'userns-denied'
  /** 当前平台没有可用的 OS 沙箱（Windows） */
  | 'platform-unsupported'
  /** 沙箱进程在执行期异常 */
  | 'exec-failed'

/** 理由：码 + 人读文案 */
export interface WorkspaceReason {
  code: WorkspaceReasonCode
  message: string
}

/** 沙箱能力探测结果（进程生命周期内缓存） */
export interface SandboxCapability {
  available: boolean
  /** 可用的实现（`available` 时必填） */
  impl?: SandboxImpl
  /** 探测到的二进制绝对路径 */
  binary?: string
  /** 不可用原因 */
  reason?: WorkspaceReason
  /** 探测时刻（ISO） */
  probedAt: string
}

/** 一次命令执行的请求：命令相关参数原样透传，另加"会话选的文件权限" */
export interface WorkspaceExecRequest extends CommandRunOptions {
  /**
   * 会话选择的文件权限（只读 / 可写），缺省 `workspace-write`。
   *
   * **它不能选择"出沙箱"**：部署策略为 `enforce`（默认）时，这里只决定沙箱内的写权限；
   * 部署策略为 `off` 时，运行时会把整条执行降级成 `danger-full-access`（自托管明确选择）。
   */
  fileAccess?: WorkspaceFileAccess
  /**
   * 沙箱可写的工作区根（命令的 `cwd` 可以是它的子目录）。
   * 省略时用 `cwd` —— 文件工具与 `bash` 共用同一个会话工作区，通常由调用方显式传入。
   */
  workspaceRoot?: string
}

/** 一次命令执行的结果：在 `CommandResult` 之上补"实际在哪执行的" */
export interface WorkspaceExecResult extends CommandResult {
  /** 实际执行环境：沙箱 / 宿主进程（`danger-full-access` 时） */
  runtime: 'sandbox' | 'local'
  /** 这次实际使用的沙箱模式 */
  mode: SandboxMode
  /** 沙箱实现（`runtime === 'sandbox'` 时） */
  impl?: SandboxImpl
}

/** 当前部署的执行能力（管理页与 `/info` 用） */
export interface WorkspaceStatus {
  /** 部署策略：`enforce` = 命令只能在沙箱里跑（不可用就拒绝）；`off` = 不管制（仅自托管） */
  mode: 'enforce' | 'off'
  /** 本部署允许会话选择的文件权限；`off` 时为空（没有隔离，也就没有"权限"可谈） */
  fileAccessOptions: WorkspaceFileAccess[]
  /** 沙箱能力（探测结果） */
  sandbox: SandboxCapability
}

/** 沙箱探测的注入口（测试可替换，生产用 `probeSandbox`） */
export interface SandboxProbeInput {
  platform: NodeJS.Platform
  /** 跑一条命令（完整命令行）；探测只用一次 */
  run: (command: string, timeoutMs: number) => Promise<CommandResult>
  /** 在 PATH 里找二进制；找不到返回 null */
  resolveBinary: (binary: string) => string | null
  timeoutMs: number
  /** 联网策略：deny 时探测也要用同样策略（保证"探测通过 = 真能跑"） */
  network: 'allow' | 'deny'
}

export type SandboxProbe = (input: SandboxProbeInput) => Promise<SandboxCapability>
