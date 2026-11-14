/** 归一化：小写、去掉空白 / 标点 / 符号（中文按字比较） */
const normalize = (value: string): string => value.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')

/** 字符二元组集合（中文短句用 bigram 足够，不引入分词器） */
const bigrams = (value: string): Set<string> => {
  const set = new Set<string>()
  for (let index = 0; index < value.length - 1; index += 1) {
    set.add(value.slice(index, index + 2))
  }
  return set
}

/**
 * 两条记忆是否"说的是同一件事"（抽取去重用，不引向量）。
 *
 * 判据从便宜到贵：
 * 1. 归一化后完全相等；
 * 2. 一方包含另一方（都 ≥6 字，避免"喜欢"命中"不喜欢"这种短串误判）；
 * 3. 字符 bigram 的 Jaccard ≥ 0.4（"偏好简短回答" vs "喜欢简短回答"能命中）。
 *    纯同义词改写（"偏好" vs "更喜欢"且无共同字）识别不了 —— 那要等向量检索（P2）。
 */
export const isSimilarMemory = (left: string, right: string): boolean => {
  const a = normalize(left)
  const b = normalize(right)
  if (!a || !b) return false
  if (a === b) return true
  if (a.length >= 6 && b.length >= 6 && (a.includes(b) || b.includes(a))) return true

  const setA = bigrams(a)
  const setB = bigrams(b)
  if (setA.size === 0 || setB.size === 0) return false
  let intersection = 0
  for (const gram of setA) if (setB.has(gram)) intersection += 1
  return intersection / (setA.size + setB.size - intersection) >= 0.4
}
