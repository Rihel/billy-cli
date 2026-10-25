/**
 * 单次回复内允许的「模型 → 工具 → 模型」最大步数。
 *
 * 取 **100** 的依据（2026-09-24 调整，原值 5 是硬顶、长任务做不了）：
 * - 对照 DSH harness：它的主循环**根本没有步数上限**（终止条件是"这一步没有工具调用"），
 *   "跑多久"是分层控制的 —— 轮次交给目标层、深度交给子 agent、超时交给工具策略、token 交给上下文压缩；
 * - 我们暂时**没有目标层**（已决定本轮不做），所以保留一个足够宽的上限兜底：100 步足够
 *   "多轮工具往返 + 反复修正"的真实任务，又不至于让"模型卡在同一个工具上"无限烧钱；
 * - 真正防失控的是这三样（都在运行时里）：上下文 70% 触发裁剪/压缩、工具幂等与子 agent 配额、
 *   以及看门狗的单轮墙钟上限（`runTimeoutMs`）。再调大这个数字只是放大"反复调同一个工具"的成本。
 */
export const AGENT_MAX_STEPS = 100

/**
 * 主 agent 的工具调用并发策略（Mastra 的 `toolCallConcurrency`）。
 *
 * 为什么显式指定：默认策略 `available` 下，工具集里只要有挂起 / 审批类工具
 * （`ask-user-questions`），**整步**工具调用都会被压成串行，子 agent 因此只能一个一个跑。
 * 改成 `called`：只有真的调用了挂起类工具的那一步才串行；同时跑几个子 agent
 * 另由 `SUB_AGENT_MAX_CONCURRENT` 的闸门限制（工具并发 ≠ 子 agent 并发）。
 */
export const AGENT_TOOL_CONCURRENCY = { strategy: 'called' } as const

/**
 * 单轮会话里**同时运行**的子 agent 上限（并发闸门按父 run 计）。
 *
 * 与总数配额（工具配置的 `maxPerRun`，默认 4）是两回事：超出并发的排队，
 * 超出总数的直接拒绝；第 4 个等前面任意一个跑完再开始。
 */
export const SUB_AGENT_MAX_CONCURRENT = 3
