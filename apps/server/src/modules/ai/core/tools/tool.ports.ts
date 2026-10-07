/**
 * 网关插件用到的**端口定义**（设计 §5.9）：只有接口与注入 token，实现各自一个文件。
 *
 * 有端口的意义：插件与网关的单测不需要 DB / Redis / 真实时钟。
 * 生产实现在 `tool.rate-counter.redis.ts` / `tool.clock.ts`；测试实现在 `test/helpers/tool-kit.ts`。
 */

/** 计数器（限流用）：返回**含本次**的窗口内计数 */
export const TOOL_RATE_COUNTER = Symbol.for('ToolRateCounter')

export interface ToolRateCounter {
  incr(key: string, windowSeconds: number): Promise<number>
}

/** 时钟端口（生产是系统时钟，测试可固定 —— 分页与耗时都要确定性） */
export const TOOL_CLOCK = Symbol.for('ToolClock')
