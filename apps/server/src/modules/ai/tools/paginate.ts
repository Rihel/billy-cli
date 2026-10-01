import type { ToolPageMeta } from './tools.types.js'

/**
 * 工具出参分页（**纯函数**，设计 §5.6）。
 *
 * 三条硬约束：
 * 1. **确定性**：同一 handle + 同一 page 永远给同一段内容 —— 不许依赖时间、随机数或进程状态。
 *    durable 恢复会重放工具调用，页不一致会让模型的上下文自相矛盾；
 * 2. **按字节切**：`pageBytes` 是字节口径（出参形状各异，按条目切是工具自己的事，列二期）；
 * 3. **不切碎多字节字符**：按 UTF-8 码点边界推进（否则页尾会出现半个汉字）。
 */

/** 序列化（分页与日志共用同一口径；`undefined` 归一成 `null`，避免 `JSON.stringify` 返回 undefined） */
export const serializeToolValue = (value: unknown): string =>
  JSON.stringify(value ?? null) ?? 'null'

/** 取页句柄：`tr:<会话 id>:<工具调用 id>`（不加密：同会话的调用者本来就有这两个 id，且取页时会校验归属） */
export const makePageHandle = (conversationId: string, toolCallId: string): string =>
  `tr:${conversationId}:${toolCallId}`

/** 解析句柄；格式不对返回 null（由调用方给 `forbidden` 结论） */
export const parsePageHandle = (
  handle: string,
): { conversationId: string; toolCallId: string } | null => {
  const parts = handle.split(':')
  if (parts.length !== 3 || parts[0] !== 'tr') return null
  const [, conversationId, toolCallId] = parts
  if (!conversationId || !toolCallId) return null
  return { conversationId, toolCallId }
}

/** 一页的内容与页头 */
export interface ToolPage {
  content: string
  meta: ToolPageMeta
}

/**
 * 切出第 `page` 页（从 1 开始）。
 *
 * 实现口径（**多字节安全 + 不重不漏**）：页边界永远落在**码点边界**上 —— 逐字符累加字节数，
 * 装不下下一个字符就另起一页。于是同一份文本的所有页**拼起来逐字节等于原文**
 * （按固定字节偏移硬切会让页边界压进半个汉字里，页与页之间既重复又漏字 —— 早先的写法就是这么错的）。
 *
 * 时间 O(n)、内存 O(pageBytes)：只保留目标页的内容，页数单独计数（大出参不复制整份）。
 * 单个字符就超过 `pageBytes` 时它独占一页（宁可超一点，也不切碎字符）。
 */
export const paginate = (
  serialized: string,
  pageBytes: number,
  page: number,
  handle: string,
): ToolPage => {
  const size = Math.max(1, Math.floor(pageBytes))
  const totalBytes = Buffer.byteLength(serialized, 'utf8')
  let totalPages = 0
  let target = ''
  let buffer = ''
  let bufferBytes = 0
  for (const char of serialized) {
    const charBytes = Buffer.byteLength(char, 'utf8')
    if (bufferBytes + charBytes > size && buffer.length > 0) {
      totalPages += 1
      if (totalPages === Math.max(1, Math.floor(page))) target = buffer
      buffer = ''
      bufferBytes = 0
    }
    buffer += char
    bufferBytes += charBytes
  }
  // 收尾那一页（空出参也算一页，保证 totalPages ≥ 1）
  totalPages += 1
  const wanted = Math.min(Math.max(1, Math.floor(page)), totalPages)
  if (wanted === totalPages) target = buffer
  return {
    content: target,
    meta: {
      page: wanted,
      pageSize: size,
      totalBytes,
      totalPages,
      hasMore: wanted < totalPages,
      handle,
    },
  }
}

/** 给模型看的那一份（页头 + 本页内容 + 取下一页的提示） */
export const toModelPage = (page: ToolPage): Record<string, unknown> => ({
  page: page.meta,
  content: page.content,
  ...(page.meta.hasMore
    ? {
        next: `还有 ${page.meta.totalPages - page.meta.page} 页：用 read-tool-result 取（handle=${page.meta.handle}, page=${page.meta.page + 1}）`,
      }
    : {}),
})
