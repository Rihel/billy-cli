/**
 * Mastra 流结果的**读取口径**（主 run 与子 run 共用，两处各写一份必然漂移）。
 *
 * 为什么需要这一层（踩过的崩点）：`agent.stream()` 的返回值**有两种形态**——
 *
 * 1. **普通形态**：`MastraModelOutput` —— `steps` / `totalUsage` / `reasoningText` 直接挂在它上面；
 * 2. **可恢复执行（`durable: true`）形态**：`AgentThreadRun` 包装对象
 *    （`{ output, fullStream, runId, threadId, resourceId, cleanup }`，字段见 `@mastra/core/dist/agent/types.d.ts`）
 *    —— 真正的 `MastraModelOutput` 在 **`output` 字段里**，包装层上**没有** `steps`。
 *
 * 于是直接写 `await output.steps` 在 durable 下拿到的是 `undefined`：轻则"每步用量不落库"，
 * 重则 `steps.entries()` 抛 `Cannot read properties of undefined (reading 'entries')`
 * 把**整轮对话判成 failed**（用户看到的现象：回答流出来了，但运行是失败的、会话没有轮次）。
 *
 * 两条硬口径：
 * - **兼容两种形态**，不让调用方去猜（判断依据是"有没有 `output` 字段"，而不是打开 durable 与否）；
 * - **拿不到就是空**（`[]` / `null`），绝不因为"读不到元数据"把已经跑完的一轮判成失败 ——
 *   正文与推理早已落库，元数据缺失是次要损失。
 */

/** 流结果里我们真正用到的最小面 */
export interface StreamResultLike {
  steps?: unknown
  totalUsage?: unknown
  usage?: unknown
}

/**
 * 取真正的 `MastraModelOutput`：包装形态（有 `output` 字段）就下钻一层，否则就是它自己。
 *
 * 只下钻一层：两种形态的差异就在这一层（包装层的 `output` 是唯一的 `MastraModelOutput`）。
 */
export const readModelOutput = (result: unknown): StreamResultLike | null => {
  if (!result || typeof result !== 'object') return null
  const wrapper = result as { output?: unknown }
  const inner = wrapper.output
  if (inner && typeof inner === 'object' && 'steps' in (inner as object)) {
    return inner as StreamResultLike
  }
  return result as StreamResultLike
}

/** 安全地 await 一个可能是 Promise 的字段（等待期间抛错按"读不到"处理，不向上冒） */
const settle = async (value: unknown): Promise<unknown> => {
  try {
    return await value
  } catch {
    return undefined
  }
}

/**
 * 每步结果（`steps` 是 getter，返回 Promise；流读完之后才 resolve）。
 *
 * 拿不到、不是数组、或等待期间抛错 → `[]`（调用方据此跳过"步骤行"，**不阻断收尾**）。
 */
export const readStreamSteps = async (result: unknown): Promise<unknown[]> => {
  const output = readModelOutput(result)
  if (!output) return []
  const steps = await settle(output.steps)
  return Array.isArray(steps) ? steps : []
}

/**
 * 本轮总用量（`totalUsage`，拿不到时回落到 `usage`）。
 *
 * 拿不到 → `undefined`（交给 `toUsageRecord` 落 `null`，前端显示"—"，**不编造 0**）。
 */
export const readStreamUsage = async (
  result: unknown,
): Promise<Record<string, unknown> | undefined> => {
  const output = readModelOutput(result)
  if (!output) return undefined
  const total = await settle(output.totalUsage)
  if (total && typeof total === 'object') return total as Record<string, unknown>
  const usage = await settle(output.usage)
  return usage && typeof usage === 'object' ? (usage as Record<string, unknown>) : undefined
}
