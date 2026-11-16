import { z } from 'zod'

/**
 * 正在跑的那一轮的「已闭合内容快照」。
 *
 * 为什么只给已闭合 part：快照经归约后只剩 parts，part id 丢了；
 * 未闭合的部分必须靠 `sinceRev` 增量原样接回，才能把 delta 接到同一个 part 上。
 *
 * - `rev`：快照覆盖到的最新 rev；
 * - `sinceRev`：增量起点（含）= 最早未闭合 part 的 start 事件的 rev；没有未闭合 part 时 = 最后一帧 rev + 1；
 * - `parts`：`UIMessage.parts` 的形状，前端直接渲染（runtime 用同一份归约口径生成）。
 */
export const AgentRunSnapshotSchema = z.object({
  runId: z.string().min(1),
  messageId: z.string(),
  rev: z.number().int().nonnegative(),
  sinceRev: z.number().int().nonnegative(),
  parts: z.array(z.unknown()),
})
export type AgentRunSnapshotModel = z.infer<typeof AgentRunSnapshotSchema>
