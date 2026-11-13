import { Injectable } from '@nestjs/common'
import { execa } from 'execa'
import type { Options as ExecaOptions } from 'execa'
import { resolveCommandRun, toCommandResult } from './command.result.js'
import type { ExecaResultLike, ResolvedCommandRun } from './command.result.js'

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
 * execa 的流式子进程里我们用到的面：`stdout` / `stderr` 可读流 + 可 await 的结果。
 *
 * 只声明最小面，不把 execa 的泛型铺进来（`ExecaResultLike` 同理）。
 */
/**
 * execa 的调用选项 —— 只此一处（结果映射与它同源，见 `command.result.ts`），
 * 否则"杀进程树 / 不抛异常 / 平台 shell"这些语义会在某一条链路上悄悄漏掉。
 */
const execaOptionsOf = (run: ResolvedCommandRun, signal?: AbortSignal): ExecaOptions => ({
  // 显式给 shell：与"操作系统画像"里的口径完全一致（审计里能解释这条命令被谁解释）
  shell: run.shell,
  cwd: run.cwd,
  timeout: run.timeoutMs,
  maxBuffer: run.maxOutputBytes,
  // 超时 / 取消时连孙进程一起杀（Unix 进程组、Windows taskkill）
  killDescendants: true,
  // 本进程退出时清理子进程（execa 默认值，写出来是为了让人看见）
  cleanup: true,
  // 不抛异常：所有失败形态都落成结果对象，再映射成中文结论
  reject: false,
  windowsHide: true,
  ...(signal ? { cancelSignal: signal } : {}),
})

/**
 * **跨平台命令执行统一入口**（基础设施能力）。
 *
 * 放置：横切基础能力 → `kits/src/foundation/command`（与 `scheduler` 同一层：
 * 提供的是与具体业务无关的"本机进程能力"）。
 *
 * **机制交给 `execa`，这层封装只做三件事**（这三件才是我们的领域决策）：
 * 1. **定策略**：把 timeout / 输出上限 clamp 到有默认、有上限的确定值（模型传什么都不越界）；
 * 2. **定口径**：把执行结果映射成**永不抛异常**的中文结果（agent 工具链路要的是可读结论，
 *    抛异常会变成"这一轮失败"）；
 * 3. **定平台口径**：shell 与"操作系统画像"由 {@link resolveShell} 按 `process.platform` 解析
 *    （`uname` / `ver` 这类命令只在部分平台存在，不作为能力底座）。
 *
 * 取数方式只有一种：**跑完一次拿全量**（{@link run}）。
 *
 * 曾经有过 `runStreaming`（按行回调、把过程实时发成 AI 工具事件），2026-10-01 **按用户口径删除**：
 * agent 用的命令通常一两秒就结束，逐行事件只剩闪烁；而输出本来就完整落在出参里（工具卡结果区
 * 会显示同一份内容），等于同一份内容在界面上出现两遍，还把消息撑长。真要"边跑边看"的长任务，
 * 应当由业务侧显式声明事件（机制还在，见设计 §5.17），而不是所有命令默认都走流式。
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
  /** 跑完一次拿全量输出（`CommandResult` 里 stdout / stderr / exitCode 都是完整的） */
  async run(options: CommandRunOptions): Promise<CommandResult> {
    const run = resolveCommandRun(options)
    const result = (await execa(
      options.command,
      execaOptionsOf(run, options.signal),
    )) as unknown as ExecaResultLike
    return toCommandResult(run, result)
  }
}
