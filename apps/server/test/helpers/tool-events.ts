import type { ToolLogger } from '../../src/modules/ai/core/tools/tools.types.js'

/**
 * 工具自定义事件测试的**共享小工具**（设计 §5.17）。
 *
 * 事件发射的硬要求几乎都是"这一次写流发生了什么 / 有没有记日志"，
 * 所以断言面就是这两个（`writer` 与 `log` 的假实现）。
 */

/** 记录全部写入的假 writer；`failFirst` 用来验"写流失败不能影响工具结果" */
export const capturingWriter = (options: { failFirst?: boolean } = {}) => {
  const chunks: unknown[] = []
  return {
    chunks,
    write: (chunk: unknown): Promise<unknown> => {
      if (options.failFirst && chunks.length === 0) {
        return Promise.reject(new Error('父流已断开'))
      }
      chunks.push(chunk)
      return Promise.resolve(undefined)
    },
  }
}

/** 记录 warn 的假日志（结构兼容 `AppLogger`，其余级别静默） */
export const warningLog = (): ToolLogger & { warnings: Array<{ message: string; data?: unknown }> } => {
  const warnings: Array<{ message: string; data?: unknown }> = []
  return {
    warnings,
    debug: () => undefined,
    log: () => undefined,
    info: () => undefined,
    error: () => undefined,
    warn: (message?: string, data?: unknown) => {
      warnings.push({ message: message ?? '', data })
    },
  }
}

/**
 * 等一个条件成立（轮询，超时即失败）。
 *
 * `emit` 刻意是**同步**函数（执行体不该被写流拖住），所以异步写入要显式等一下才断言得到；
 * 写失败时不会有新块，只能靠这条等日志 —— 比固定 `setTimeout` 稳，也比"猜几跳微任务"清楚。
 */
export const waitFor = async (check: () => boolean, timeoutMs = 1000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('等待超时：条件未在预期时间内成立')
}
