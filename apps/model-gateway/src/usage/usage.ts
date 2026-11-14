import type { GatewayUsage } from '@repo/contracts'

const num = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {}

/**
 * 从上游响应 / SSE 事件 / 各协议翻译后的响应里提取用量。
 *
 * 兼容三类字段：
 * - OpenAI / DeepSeek：`prompt_tokens` / `completion_tokens` / `prompt_cache_hit_tokens` /
 *   `prompt_tokens_details.cached_tokens` / `completion_tokens_details.reasoning_tokens`；
 * - Anthropic（翻译前）：`input_tokens` / `output_tokens` / `cache_read_input_tokens` /
 *   `cache_creation_input_tokens`；
 * - 缺失：返回 null（由调用方记 `usage_missing`，不编造 0）。
 */
export const usageOf = (payload: unknown): GatewayUsage | null => {
  const row = record(payload)
  // OpenAI/DeepSeek 顶层 usage；Anthropic 的 message_start 在 message.usage 里
  const usage =
    Object.keys(record(row.usage)).length > 0
      ? record(row.usage)
      : record(record(row.message).usage)
  if (Object.keys(usage).length === 0) return null
  const input = num(usage.prompt_tokens) ?? num(usage.input_tokens)
  const output = num(usage.completion_tokens) ?? num(usage.output_tokens)
  const cacheRead =
    num(usage.prompt_cache_hit_tokens) ??
    num(record(usage.prompt_tokens_details).cached_tokens) ??
    num(usage.cache_read_input_tokens)
  const cacheWrite =
    num(usage.cache_creation_input_tokens) ??
    num(record(usage.prompt_tokens_details).cache_write_tokens)
  const reasoning = num(record(usage.completion_tokens_details).reasoning_tokens)
  const total =
    num(usage.total_tokens) ?? (input !== null && output !== null ? input + output : null)
  if (input === null && output === null && total === null) return null
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: total,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    reasoningTokens: reasoning,
  }
}

/** 模型行上的价格快照（写入 usage 行，之后改价不影响历史） */
export interface PriceRates {
  currency: string
  inputPer1m: number | null
  outputPer1m: number | null
  cacheReadPer1m: number | null
  cacheWritePer1m: number | null
  perImage: number | null
  perSecond: number | null
}

/**
 * 成本（**微元**，整数；1 元 = 1e6 微元）。
 *
 * 口径：价格是「`currency` / 1M tokens」时，`tokens × price` 正好等于微元
 * （price 元/1M × tokens = 元/1e6 × tokens → 微元）。
 * 任一必需价格缺失就返回 null（**不估算**）；缓存 token 存在但缓存价缺失同样记 null。
 */
export const costMicrosOf = (
  usage: GatewayUsage | null,
  rates: PriceRates | null,
  units: { images?: number; seconds?: number } = {},
): { costMicros: number | null; priceSnapshot: PriceRates | null } => {
  if (!rates) return { costMicros: null, priceSnapshot: null }
  let total = 0
  let priced = true
  const addTokens = (tokens: number | null, rate: number | null): void => {
    if (!tokens) return
    if (rate === null) {
      priced = false
      return
    }
    total += tokens * rate
  }
  if (usage) {
    addTokens(usage.inputTokens, rates.inputPer1m)
    addTokens(usage.outputTokens, rates.outputPer1m)
    addTokens(usage.cacheReadTokens, rates.cacheReadPer1m)
    addTokens(usage.cacheWriteTokens, rates.cacheWritePer1m)
  }
  if (units.images) addTokens(units.images, rates.perImage === null ? null : rates.perImage * 1e6)
  if (units.seconds)
    addTokens(units.seconds, rates.perSecond === null ? null : rates.perSecond * 1e6)
  return {
    costMicros: priced ? Math.round(total) : null,
    priceSnapshot: rates,
  }
}

/** 逐字段合并两份 usage（流式事件里 input 与 output 分在不同事件） */
export const mergeUsage = (left: GatewayUsage, right: GatewayUsage): GatewayUsage => {
  const pick = (a: number | null, b: number | null): number | null => b ?? a
  return {
    inputTokens: pick(left.inputTokens, right.inputTokens),
    outputTokens: pick(left.outputTokens, right.outputTokens),
    totalTokens: pick(left.totalTokens, right.totalTokens),
    cacheReadTokens: pick(left.cacheReadTokens, right.cacheReadTokens),
    cacheWriteTokens: pick(left.cacheWriteTokens, right.cacheWriteTokens),
    reasoningTokens: pick(left.reasoningTokens, right.reasoningTokens),
  }
}
