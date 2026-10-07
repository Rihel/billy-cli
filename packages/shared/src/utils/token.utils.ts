/**
 * 多模态内容的 token 估算（前后端 / 各服务共用的那一份规则）。
 *
 * 为什么要单独一份：**一张 2MB 图片转成 data URL 是几百万字符**，按"4 字符 ≈ 1 token"折算
 * 会得出"上下文已经爆了"的假结论，随即触发一次毫无必要、还要真花钱的压缩。
 * 所以媒体部分一律按**固定成本**计 —— 各家视觉模型的图片计价差异很大，宁可估高：
 * 估高只会让我们更早裁历史，估低会直接被上游 400。
 */

/**
 * 单个媒体 part（图片 / 文件）折算的 token 成本。
 *
 * 取 1500：主流视觉模型把一张常规图片折算到数百到一千多 token，按上限估偏保守。
 */
export const MULTIMODAL_PART_TOKENS = 1500

/**
 * 估计算法只需要认得的字段。
 *
 * 刻意**不绑 `UserContent`**：服务端还要对助手消息的内容（可能含推理 / 工具调用 part）做同样的折算，
 * 按结构声明才能两头都收 —— 只认 `type` 与 `text`，其余 part 一律按序列化长度兜底。
 */
export type EstimablePart = { type: string; text?: string }

/** 保守估算 token：中文按字、其它按 4 字符 ≈ 1 token（本地没有各家 tokenizer，一律估算） */
export const estimateTextTokens = (text: string): number => {
  let cjk = 0
  let other = 0
  for (const char of text) {
    if (char.charCodeAt(0) > 0x2e80) cjk += 1
    else other += 1
  }
  return cjk + Math.ceil(other / 4)
}

/**
 * 估算一份内容（字符串或多模态 part 数组）的 token。
 *
 * 媒体 part 走 {@link MULTIMODAL_PART_TOKENS}；文本 part 走字符折算；
 * 其余 part 按序列化长度折算（与既有的"工具调用 / 工具结果"口径一致）。
 */
export const estimateContentTokens = (content: string | readonly EstimablePart[]): number => {
  if (typeof content === 'string') {
    return estimateTextTokens(content)
  }
  let total = 0
  for (const part of content) {
    if (part.type === 'text') {
      total += estimateTextTokens(part.text ?? '')
      continue
    }
    if (part.type === 'image' || part.type === 'file') {
      total += MULTIMODAL_PART_TOKENS
      continue
    }
    total += estimateTextTokens(JSON.stringify(part))
  }
  return total
}
