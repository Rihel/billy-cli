import { resolveShell } from './command.platform.js'
import type { CommandResult, CommandRunOptions } from './command.runner.js'

/**
 * 命令执行的**公共口径**：入参收窄 + 「execa 结果 → `CommandResult`」的纯映射。
 *
 * 为什么单独一个文件：命令执行门面（`command.runner.ts`）只该管"怎么跑进程"，
 * 只是**取数据的方式**不同，但"失败怎么归类、退出码怎么读、输出超限算不算失败"必须是**同一套判断** ——
 * 否则同一台机器上，同一条命令经两条链路会给出两个结论，工具出参就不可信了。
 * 这里就是那唯一一份判断（纯函数：不碰进程、不读时钟，只吃 execa 的结果对象）。
 */

/**
 * execa 结果里**我们用到的那几个字段**。
 *
 * 不把 execa 的泛型签名铺进本文件（它的 `Result` 类型随 options 变化，读起来成本很高）：
 * 这里声明最小面，映射时做一次收窄 —— 与 `planner.core.ts` 的 `ToolContextLike` 同一手法。
 */
export interface ExecaResultLike {
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

export const DEFAULT_TIMEOUT_MS = 15_000
export const MAX_TIMEOUT_MS = 5 * 60_000
export const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(Math.trunc(value), min), max)

/** 入参收窄之后的确定值（两条执行链路共用；`shell` / `cwd` 已经解析成实际取值） */
export interface ResolvedCommandRun {
  /** 原样回显的命令行 */
  command: string
  /** 解释这条命令的 shell */
  shell: string
  /** 实际工作目录（绝对路径） */
  cwd: string
  /** 超时（已 clamp 到 1ms..5min） */
  timeoutMs: number
  /** 单条流输出上限（已 clamp 到 ≥1 字节） */
  maxOutputBytes: number
}

/**
 * 把调用方给的入参收窄成"有默认、有上限"的确定值。
 *
 * 这是**唯一的策略入口**：模型 / 工具传什么都不越界（时长与输出上限都在这里夹紧），
 * 门面里不再混着"结果怎么读"的细节。
 */
export const resolveCommandRun = (options: CommandRunOptions): ResolvedCommandRun => {
  const platform = options.platform ?? process.platform
  return {
    command: options.command,
    shell: options.shell ?? resolveShell(platform),
    cwd: options.cwd ?? process.cwd(),
    timeoutMs: clamp(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1, MAX_TIMEOUT_MS),
    maxOutputBytes: clamp(
      options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
      1,
      Number.MAX_SAFE_INTEGER,
    ),
  }
}

/**
 * execa 结果 → **永不抛异常**的中文结果（出参契约的唯一事实源）。
 *
 * 失败一律落成可读结论而不是异常：agent 工具链路要的是"模型能自己纠正的结论"，
 * 抛出去会变成"这一轮失败"。分类顺序是刻意的：中止 → 超时 → 截断 → 非零退出 → 没跑起来，
 * 于是 `aborted` / `timedOut` / `truncated` 三种终止原因不会互相冒充。
 */
export const toCommandResult = (run: ResolvedCommandRun, result: ExecaResultLike): CommandResult => {
  const base: CommandResult = {
    ok: !result.failed,
    command: run.command,
    shell: run.shell,
    cwd: run.cwd,
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
      reason: `命令超过 ${run.timeoutMs}ms 仍未结束，已被终止（输出为终止前已读到的部分）`,
    }
  }
  if (result.isMaxBuffer) {
    return {
      ...base,
      reason: `命令输出超过 ${run.maxOutputBytes} 字节，已截断并终止（输出为已读到的部分）`,
    }
  }
  if (typeof result.exitCode === 'number') {
    return { ...base, reason: `命令以退出码 ${result.exitCode} 结束` }
  }
  // 进程根本没跑起来（cwd 不存在 / shell 找不到 / 权限不足…）：execa 把原因放在 message 里
  return { ...base, reason: `命令未能执行：${result.message ?? '未知原因'}` }
}
