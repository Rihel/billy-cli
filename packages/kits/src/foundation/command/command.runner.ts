import { Injectable } from '@nestjs/common'
import { execa } from 'execa'
import { resolveShell } from './command.platform.js'

/**
 * 命令执行的入参。
 *
 * 全部可选值都在这里收口成"有默认、有上限"的确定行为：
 * 调用方（agent 工具）只负责按策略填，**不自己实现超时与截断**。
 */
export interface CommandRunOptions {
  /** 整条命令行（由 `shell` 解释，按平台语法书写） */
  command: string
  /** 工作目录；缺省用服务进程的工作目录 */
  cwd?: string
  /** 超时（ms）；缺省 15s，上限 5 分钟 */
  timeoutMs?: number
  /** 单条流（stdout / stderr 各自）的输出上限（字节）；超出即截断并终止 */
  maxOutputBytes?: number
  /** 中止信号（用户停止 / 这一轮结束）——触发即杀掉整棵进程树 */
  signal?: AbortSignal
  /** 平台覆盖（单测用；缺省 `process.platform`） */
  platform?: NodeJS.Platform
  /** shell 覆盖（单测用；缺省按平台解析） */
  shell?: string
}

/** 命令执行结果：**永不抛异常**，失败也是一份可读的结果（模型据此自己纠正） */
export interface CommandResult {
  /** 命令是否正常结束（退出码 0） */
  ok: boolean
  /** 原样回显的命令行（模型与审计都要知道到底跑了什么） */
  command: string
  /** 解释这条命令的 shell（Windows `cmd.exe` / POSIX `/bin/sh`） */
  shell: string
  /** 实际工作目录（绝对路径） */
  cwd: string
  /** 退出码；`null` 表示进程没跑起来（如目录不存在）或被信号终止 */
  exitCode: number | null
  stdout: string
  stderr: string
  /** 超时被终止 */
  timedOut: boolean
  /** 被中止信号终止（用户点了停止） */
  aborted: boolean
  /** 输出超过上限被截断（只保留已读到的部分） */
  truncated: boolean
  durationMs: number
  /** 失败原因（中文一句话；`ok` 为 true 时不出现） */
  reason?: string
}

/**
 * execa 结果里**我们用到的那几个字段**。
 *
 * 不把 execa 的泛型签名铺进本文件（它的 `Result` 类型随 options 变化，读起来成本很高）：
 * 这里声明最小面，`run()` 里做一次收窄 —— 与 `planner.core.ts` 的 `ToolContextLike` 同一手法。
 */
interface ExecaResultLike {
  /** 是否失败（非零退出 / 超时 / 被取消 / 输出超限 / 起不来） */
  failed: boolean
  timedOut: boolean
  isCanceled: boolean
  isMaxBuffer: boolean
  exitCode?: number
  stdout: string
  stderr: string
  durationMs: number
  message?: string
}

const DEFAULT_TIMEOUT_MS = 15_000
const MAX_TIMEOUT_MS = 5 * 60_000
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(Math.trunc(value), min), max)

/**
 * **跨平台命令执行门面**（基础设施能力）。
 *
 * 归位：横切基础能力 → `kits/src/foundation/command`（与 `scheduler` 同一层：
 * 提供的是与具体业务无关的"本机进程能力"）。
 *
 * **机制交给 `execa`，本门面只做三件事**（这三件才是我们的领域决策）：
 * 1. **定策略**：把 timeout / 输出上限 clamp 到有默认、有上限的确定值（模型传什么都不越界）；
 * 2. **定口径**：把执行结果映射成**永不抛异常**的中文结果（agent 工具链路要的是可读结论，
 *    抛异常会变成"这一轮失败"）；
 * 3. **定平台口径**：shell 与"操作系统画像"由 {@link resolveShell} 按 `process.platform` 解析
 *    （`uname` / `ver` 这类命令只在部分平台存在，不作为能力底座）。
 *
 * 为什么用 execa 而不是自己 `child_process.exec`（早先手写过一版，已弃）：
 * - **跨平台**：Unix `/bin/sh -c`、Windows `cmd.exe /d /s /c` 由它处理，不用我们写分支；
 * - **杀进程树**：`killDescendants: true` 在 Unix 用进程组、在 Windows 用 `taskkill` ——
 *   `shell: true` 下超时只杀 shell 会把孙进程留成孤儿（手写版在 Windows 上解决不了）；
 * - **不抛异常**：`reject: false` 让"非零退出 / 超时 / 取消 / 输出超限 / 起不来"都落到结果对象上，
 *   字段名（`timedOut` / `isCanceled` / `isMaxBuffer` / `exitCode`）比 catch 里猜错误码可靠；
 * - **清理**：`cleanup`（默认开）保证本进程退出时不留子进程。
 *
 * 编码：统一按 UTF-8 解码。中文 Windows 的 `cmd.exe` 默认代码页是 GBK，中文输出可能乱码 ——
 * 这条**如实暴露**（乱码在 stdout 里看得见），不静默转码猜测。
 */
@Injectable()
export class CommandRunner {
  async run(options: CommandRunOptions): Promise<CommandResult> {
    const platform = options.platform ?? process.platform
    const shell = options.shell ?? resolveShell(platform)
    const cwd = options.cwd ?? process.cwd()
    const timeoutMs = clamp(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1, MAX_TIMEOUT_MS)
    const maxOutputBytes = clamp(
      options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
      1,
      Number.MAX_SAFE_INTEGER,
    )

    const result = (await execa(options.command, {
      // 显式给 shell：与"操作系统画像"里的口径完全一致（审计里能解释这条命令被谁解释）
      shell,
      cwd,
      timeout: timeoutMs,
      maxBuffer: maxOutputBytes,
      // 超时 / 取消时连孙进程一起杀（Unix 进程组、Windows taskkill）
      killDescendants: true,
      // 本进程退出时清理子进程（execa 默认值，写出来是为了让人看见）
      cleanup: true,
      // 不抛异常：所有失败形态都落成结果对象，由下面映射成中文结论
      reject: false,
      windowsHide: true,
      ...(options.signal ? { cancelSignal: options.signal } : {}),
    })) as unknown as ExecaResultLike

    const base: CommandResult = {
      ok: !result.failed,
      command: options.command,
      shell,
      cwd,
      exitCode: result.exitCode ?? null,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      timedOut: result.timedOut,
      aborted: result.isCanceled,
      truncated: result.isMaxBuffer,
      durationMs: result.durationMs,
    }
    if (!result.failed) return base

    if (result.isCanceled) {
      return { ...base, reason: '命令已被中止（用户停止或这一轮已结束）' }
    }
    if (result.timedOut) {
      return {
        ...base,
        reason: `命令超过 ${timeoutMs}ms 仍未结束，已被终止（输出为终止前已读到的部分）`,
      }
    }
    if (result.isMaxBuffer) {
      return {
        ...base,
        reason: `命令输出超过 ${maxOutputBytes} 字节，已截断并终止（输出为已读到的部分）`,
      }
    }
    if (typeof result.exitCode === 'number') {
      return { ...base, reason: `命令以退出码 ${result.exitCode} 结束` }
    }
    // 进程根本没跑起来（cwd 不存在 / shell 找不到 / 权限不足…）：execa 把原因放在 message 里
    return { ...base, reason: `命令未能执行：${result.message ?? '未知原因'}` }
  }
}
