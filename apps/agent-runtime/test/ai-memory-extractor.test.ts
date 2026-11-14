import { describe, expect, it } from 'vitest'
import {
  EXTRACT_MAX_CANDIDATES,
  parseExtractionCandidates,
  shouldTryExtraction,
} from '../src/modules/ai/memory/memory.extractor.service.js'
import { isSimilarMemory } from '../src/modules/ai/memory/memory.similarity.js'

/** 轮后抽取：触发条件、JSON 解析、去重判据（都不需要模型） */
describe('shouldTryExtraction（触发条件）', () => {
  it('信号词命中就抽', () => {
    expect(shouldTryExtraction('记住：我喜欢简短回答', 1)).toBe(true)
    expect(shouldTryExtraction('以后都用 TypeScript 写', 1)).toBe(true)
  })

  it('没有信号词时按轮数扫（每 6 轮）', () => {
    expect(shouldTryExtraction('帮我看看这个报错', 5)).toBe(false)
    expect(shouldTryExtraction('帮我看看这个报错', 6)).toBe(true)
    // 首轮不算"扫描轮"
    expect(shouldTryExtraction('帮我看看这个报错', 0)).toBe(false)
  })
})

describe('parseExtractionCandidates（模型输出解析）', () => {
  it('解析纯 JSON 数组', () => {
    const candidates = parseExtractionCandidates(
      '[{"kind":"preference","content":"偏好简短回答","key":"reply-style"}]',
    )
    expect(candidates).toEqual([
      { kind: 'preference', content: '偏好简短回答', key: 'reply-style' },
    ])
  })

  it('容忍 Markdown 代码块与前后解释', () => {
    const candidates = parseExtractionCandidates(
      '好的，结果如下：\n```json\n[{"content":"常用 TypeScript"}]\n```\n',
    )
    expect(candidates).toEqual([{ kind: 'fact', content: '常用 TypeScript' }])
  })

  it('非法 / 超长 / 缺字段的条目丢掉，正常条目保留', () => {
    const candidates = parseExtractionCandidates(
      JSON.stringify([
        { content: 'a' }, // 太短
        { kind: 'unknown-kind', content: '这条类型不合法' }, // 类型不在字典里
        { kind: 'fact', content: '这条正常' },
      ]),
    )
    expect(candidates.map((item) => item.content)).toEqual(['这条正常'])
  })

  it('最多取 N 条', () => {
    const candidates = parseExtractionCandidates(
      JSON.stringify(
        Array.from({ length: 10 }, (_, index) => ({ content: `第 ${index} 条稳定信息` })),
      ),
    )
    expect(candidates).toHaveLength(EXTRACT_MAX_CANDIDATES)
  })

  it('不是 JSON 就返回空数组（模型不听话不影响这一轮）', () => {
    expect(parseExtractionCandidates('没有可记的')).toEqual([])
    expect(parseExtractionCandidates(null)).toEqual([])
  })
})

describe('isSimilarMemory（抽取去重）', () => {
  it('完全一样 / 互相包含算重复', () => {
    expect(isSimilarMemory('偏好简短回答', '偏好简短回答')).toBe(true)
    expect(isSimilarMemory('偏好简短回答', '用户偏好简短回答')).toBe(true)
  })

  it('说法不同但意思接近也算', () => {
    expect(isSimilarMemory('偏好简短回答', '喜欢简短回答')).toBe(true)
  })

  it('不同的事不算', () => {
    expect(isSimilarMemory('偏好简短回答', '常用 TypeScript')).toBe(false)
  })
})
