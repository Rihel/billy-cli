import type { ToolRateCounter } from '../../src/modules/ai/core/tools/tool.ports.js'

/**
 * 测试用的**内存端口实现**（设计 §5.9：生产实现是 Redis，测试实现是内存）。
 *
 * 放在测试目录而不是 `src/`：它只有测试会用 —— 生产装配不该出现"第二套计数实现"。
 */
export class MemoryToolRateCounter implements ToolRateCounter {
  private readonly counts = new Map<string, number>()

  async incr(key: string): Promise<number> {
    const next = (this.counts.get(key) ?? 0) + 1
    this.counts.set(key, next)
    return next
  }

  /** 测试断言用：读当前计数 */
  peek(key: string): number {
    return this.counts.get(key) ?? 0
  }
}
