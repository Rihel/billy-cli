import { createHash } from 'node:crypto'

/**
 * 递归按 key 排序后再序列化：同一个入参只要内容相同，哈希就必须相同。
 *
 * 为什么不用裸 `JSON.stringify`：重放时的参数来自模型历史消息，键顺序理论上与首次一致，
 * 但一旦不一致就会被判成「换了参数的冲突」，把一个合法重放拦掉 —— 冲突是坏事，
 * 宁可多这一步规范化。
 */
const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value === null || typeof value !== 'object') return value
  const source = value as Record<string, unknown>
  const sorted: Record<string, unknown> = {}
  for (const key of Object.keys(source).sort()) sorted[key] = canonicalize(source[key])
  return sorted
}

/** 一次调用的入参指纹（32 位十六进制，落 `request_hash` varchar(32)） */
export const canonicalHash = (value: unknown): string =>
  createHash('sha256')
    .update(JSON.stringify(canonicalize(value)))
    .digest('hex')
    .slice(0, 32)
