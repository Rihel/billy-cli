/**
 * 消耗（token）相关的**纯函数**：主 run 与子 run 共用同一套折算口径。
 *
 * 单独成文件而不是留在 `chat.service.ts`：子 agent 执行器（`agent-runner.ts`）也要落消耗，
 * 两处各写一份必然漂移（设计文档 §4.7 要求"口径唯一"）。
 */

/**
 * 把 Mastra / AI SDK 的 `LanguageModelUsage` 收敛成可落库的普通对象。
 *
 * 各 provider 上这些字段**都可能为 `undefined`**（如不支持缓存或不返回推理 token）→
 * 统一落 `null`，前端缺失就显示"—"，**不编造 0**（0 与"没上报"是两件事）。
 *
 * ⚠️ **缓存读要读两处**（实测确认，踩过）：Mastra 的 `totalUsage` **顶层**就有
 * `cachedInputTokens`（DeepSeek 同一段提示第二次请求实测 1408），而嵌套的
 * `inputTokenDetails.cacheReadTokens` 在该适配下是空的 ——
 * 早先只读嵌套那一处，于是**缓存命中永远是 `null`**（用户看到的"缓存命中没数"）。
 * 顶层优先（跨 provider 更普遍），嵌套作兜底（保留 AI SDK 新形态）。
 * 推理 token 同理会出现在 `reasoningTokens` 或 `outputTokenDetails.reasoningTokens`。
 */
export const toUsageRecord = (
  usage: Record<string, unknown> | undefined | null,
): Record<string, unknown> | null => {
  if (!usage) return null
  const input = usage.inputTokens as number | undefined
  const output = usage.outputTokens as number | undefined
  const inputDetails = (usage.inputTokenDetails ?? {}) as Record<string, unknown>
  const outputDetails = (usage.outputTokenDetails ?? {}) as Record<string, unknown>
  return {
    inputTokens: input ?? null,
    outputTokens: output ?? null,
    totalTokens: (usage.totalTokens as number | undefined) ?? null,
    cacheReadTokens:
      (usage.cachedInputTokens as number | undefined) ??
      (inputDetails.cacheReadTokens as number | undefined) ??
      null,
    // 写缓存（cache write）目前只有部分 provider 上报，且只在嵌套结构里
    cacheWriteTokens: (inputDetails.cacheWriteTokens as number | undefined) ?? null,
    reasoningTokens:
      (usage.reasoningTokens as number | undefined) ??
      (outputDetails.reasoningTokens as number | undefined) ??
      null,
  }
}

/** 取 totalTokens（缺失按 0 计；只用于"累计"这种加法场景） */
export const totalTokensOf = (usage: Record<string, unknown> | null): number =>
  typeof usage?.totalTokens === 'number' ? usage.totalTokens : 0

/** 读一条 usage 记录里的某个 token 字段（读不到按 0 计） */
export const usageField = (usage: Record<string, unknown> | null, field: string): number =>
  typeof usage?.[field] === 'number' ? (usage[field] as number) : 0

/**
 * 把若干份 usage **逐字段相加**（子 agent 的消耗汇总进父 run，§4.7）。
 *
 * 相加而不是取最大：父子是两次独立的模型计费，都要算钱。
 * 某字段全为 null 时结果仍是 null（"都没上报"不能变成 0）。
 */
export const mergeUsage = (
  ...records: Array<Record<string, unknown> | null | undefined>
): Record<string, unknown> | null => {
  const present = records.filter((record): record is Record<string, unknown> => Boolean(record))
  if (present.length === 0) return null
  const fields = [
    'inputTokens',
    'outputTokens',
    'totalTokens',
    'cacheReadTokens',
    'cacheWriteTokens',
    'reasoningTokens',
  ]
  const merged: Record<string, unknown> = {}
  for (const field of fields) {
    const known = present.filter((record) => typeof record[field] === 'number')
    merged[field] =
      known.length === 0
        ? null
        : known.reduce((sum, record) => sum + (record[field] as number), 0)
  }
  return merged
}
