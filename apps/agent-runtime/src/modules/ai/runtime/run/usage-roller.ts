import type { RunRepository } from './run.repository.js'
import { mergeUsage } from './usage.js'

/**
 * 把子 agent 的消耗汇总进父 run（**父的合计已含子**）。
 *
 * 会话累计只按根 run 累加，所以全链路只算一次钱；子 agent 自己那一份仍留在它自己的 run 里，
 * 父的 `usage.subAgents` 保留子的明细（谁的活花了多少，两边都查得到）。
 */
export const rollUpUsage = async (
  runs: RunRepository,
  runId: string,
  own: Record<string, unknown> | null,
): Promise<Record<string, unknown> | null> => {
  const children = await runs.listChildUsages(runId)
  if (children.length === 0) return own
  const subAgents = mergeUsage(...children)
  return { ...own, subAgents, ...mergeUsage(own, subAgents) }
}
