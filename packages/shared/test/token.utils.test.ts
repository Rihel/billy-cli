import { describe, expect, it } from 'vitest'
import {
  estimateContentTokens,
  estimateTextTokens,
  MULTIMODAL_PART_TOKENS,
} from '../src/utils/token.utils'

/**
 * 多模态内容的 token 估算。
 *
 * 为什么值得单独钉住：这里一旦回退成"按 JSON 长度折算"，一张 2MB 图片会被算成几十万 token，
 * 于是每次带图都触发一次**要真花钱**的上文压缩，或者直接抛 3307 —— 症状离原因很远。
 */
describe('estimateTextTokens', () => {
  it('中文按字、其它按 4 字符', () => {
    expect(estimateTextTokens('你好世界')).toBe(4)
    expect(estimateTextTokens('abcd')).toBe(1)
    expect(estimateTextTokens('abcdefgh')).toBe(2)
  })
})

describe('estimateContentTokens', () => {
  it('纯字符串与文本 part 走同一套字符折算', () => {
    expect(estimateContentTokens('你好')).toBe(2)
    expect(estimateContentTokens([{ type: 'text', text: '你好' }])).toBe(2)
  })

  it('图片 part 按固定成本计，**与 data URL 长度无关**', () => {
    const small = estimateContentTokens([
      { type: 'image' },
    ])
    const huge = estimateContentTokens([
      // 模拟一张 2MB 图片转成的 data URL：几百万字符（`EstimablePart` 只认 type，长度不影响结果）
      { type: 'image', dataUrl: `data:image/png;base64,${'A'.repeat(2_000_000)}` },
    ] as never)
    expect(small).toBe(MULTIMODAL_PART_TOKENS)
    expect(huge).toBe(MULTIMODAL_PART_TOKENS)
  })

  it('文件 part 同样按固定成本计', () => {
    expect(estimateContentTokens([{ type: 'file' }])).toBe(MULTIMODAL_PART_TOKENS)
  })

  it('认不出的 part 仍按序列化长度兜底（不静默算成 0）', () => {
    expect(estimateContentTokens([{ type: 'tool-call', name: 'x' }] as never)).toBeGreaterThan(0)
  })

  it('文本 + 图片混排各自计一份', () => {
    expect(estimateContentTokens([{ type: 'text', text: 'abcd' }, { type: 'image' }])).toBe(
      1 + MULTIMODAL_PART_TOKENS,
    )
  })
})
