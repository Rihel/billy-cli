/** 引擎侧最小用量结构；与 shared 的用量模型解耦 */
export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  cacheReadTokens?: number
  reasoningTokens?: number
}
