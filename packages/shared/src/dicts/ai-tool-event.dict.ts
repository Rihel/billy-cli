import { createDict } from '../utils'

/**
 * 工具自定义事件的字典（设计 `docs/design/ai-agent-tool-engine.md` §5.17）。
 */

/**
 * 事件的发出方式：决定 AI SDK 的 **id 归并**策略（前端因此只看到"最新快照"或"全部流水"）。
 *
 * AI SDK data part 的语义是「同 `id` 后者覆盖前者」，所以归并策略必须在**服务端**定：
 * 事件怎么发，前端就怎么看到 —— 前端不需要自己判断去重。
 */
export const ToolEventMode = createDict({
  /** 状态快照：带稳定 id（`<toolCallId>:<event>`），后发的覆盖先发的 —— 进度 / 当前阶段 */
  State: { label: '状态快照', value: 'state' },
  /** 流水追加：不带 id，一块一条 —— 日志行 / 产物行 */
  Stream: { label: '流水追加', value: 'stream' },
})
