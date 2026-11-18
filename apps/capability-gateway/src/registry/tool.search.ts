/**
 * **工具检索（BM25）**：给定自然语言 query，从能力目录里挑出最相关的 k 个工具。
 *
 * 为什么是 BM25 而不是 embedding：零模型调用、零 token（打分纯本地 CPU），
 * 在"几十到几百个工具"的量级上足够好；代价是依赖词面（同义词靠 `tags` 补）。
 *
 * 中文处理：工具描述是中文，BM25 按空格切词会直接失效，所以
 * **CJK 用字符 unigram + bigram**（`查天气` → `查`/`天`/`气`/`查天`/`天气`），
 * 英文 / 工具名按 `[a-z0-9]+` 切。字段加权用"重复 token"实现（key ×3、title ×2、tags ×2、description ×1）。
 */

const K1 = 1.2
const B = 0.75

export interface SearchDoc {
  key: string
  title: string
  description: string
  tags?: readonly string[]
}

const CJK = /[\u4e00-\u9fff]/

/** 切词：英文/数字按 token；CJK 连续段出 unigram + bigram */
export const tokenize = (text: string): string[] => {
  const tokens: string[] = []
  for (const part of text.toLowerCase().match(/[a-z0-9]+|[\u4e00-\u9fff]+/g) ?? []) {
    if (!CJK.test(part)) {
      tokens.push(part)
      continue
    }
    const chars = Array.from(part)
    for (const char of chars) tokens.push(char)
    for (let index = 0; index + 1 < chars.length; index += 1) {
      tokens.push(`${chars[index]}${chars[index + 1]}`)
    }
  }
  return tokens
}

const weightedTokens = (doc: SearchDoc): string[] => [
  ...tokenize(doc.key),
  ...tokenize(doc.key),
  ...tokenize(doc.key),
  ...tokenize(doc.title),
  ...tokenize(doc.title),
  ...tokenize(doc.tags?.join(' ') ?? ''),
  ...tokenize(doc.tags?.join(' ') ?? ''),
  ...tokenize(doc.description),
]

export interface SearchHit<T extends SearchDoc> {
  doc: T
  score: number
}

/**
 * BM25 检索（返回按分数降序的前 `limit` 条；无命中返回空数组）。
 *
 * 文档量小（几百条以内），每次现算 df / avgdl，不维护索引；真到上千再加缓存。
 */
export const searchTools = <T extends SearchDoc>(
  query: string,
  docs: readonly T[],
  limit = 8,
): SearchHit<T>[] => {
  const queryTokens = [...new Set(tokenize(query))]
  if (queryTokens.length === 0 || docs.length === 0) return []

  const docTokens = docs.map((doc) => weightedTokens(doc))
  const docLengths = docTokens.map((tokens) => tokens.length)
  const avgdl = docLengths.reduce((sum, length) => sum + length, 0) / Math.max(1, docs.length)
  const df = new Map<string, number>()
  for (const tokens of docTokens) {
    for (const token of new Set(tokens)) df.set(token, (df.get(token) ?? 0) + 1)
  }
  const idf = (token: string): number => {
    const frequency = df.get(token) ?? 0
    return Math.log(1 + (docs.length - frequency + 0.5) / (frequency + 0.5))
  }
  const tfs = docTokens.map((tokens) => {
    const counts = new Map<string, number>()
    for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1)
    return counts
  })

  const hits: SearchHit<T>[] = []
  docs.forEach((doc, index) => {
    const length = docLengths[index]!
    let score = 0
    for (const token of queryTokens) {
      const tf = tfs[index]!.get(token) ?? 0
      if (tf === 0) continue
      score +=
        idf(token) * ((tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * length) / Math.max(1, avgdl))))
    }
    if (score > 0) hits.push({ doc, score })
  })

  return hits
    .sort((left, right) => right.score - left.score || left.doc.key.localeCompare(right.doc.key))
    .slice(0, Math.max(1, limit))
}
