import { describe, expect, it } from 'vitest'
import {
  attachmentCapabilityIssue,
  looksLikeImage,
  looksLikePdf,
} from '../src/dicts/ai-capability.dict'

/**
 * 附件是否超出模型能收的范围。
 *
 * 这套判据决定"用户发的图会不会被静默丢掉"，而且**前后端共用**（前端提前拦、服务端权威校验），
 * 所以每条都要钉住 —— 尤其是三态：未声明不拦、明确不支持才拦。
 */

const image = { filename: 'shot.png', mediaType: 'image/png' }
const pdf = { filename: 'doc.pdf', mediaType: 'application/pdf' }
const text = { filename: 'note.md', mediaType: 'text/markdown' }

describe('attachmentCapabilityIssue', () => {
  it('**未声明（null）→ 不拦**，但给出 undeclared 提示', () => {
    // 国内厂商普遍不给模态信息，硬拦会把真正的视觉模型也误伤
    expect(attachmentCapabilityIssue(null, [image])).toEqual({
      code: 'undeclared',
      filename: 'shot.png',
    })
    expect(attachmentCapabilityIssue(undefined, [image])).toEqual({
      code: 'undeclared',
      filename: 'shot.png',
    })
  })

  it('明确只声明了文本 → 图片被拦下，并指出是哪个文件', () => {
    expect(attachmentCapabilityIssue(['text'], [image])).toEqual({
      code: 'vision',
      filename: 'shot.png',
    })
  })

  it('**PDF 一律放行**，不要求模型有"文件输入"能力', () => {
    // PDF 我们自己抽文字层内联（抽不出才退回文件通道，那一步在服务端读文件时判能力），
    // 所以这里不该因为模型没声明 `file` 就把用户的 PDF 拦下（2026-10-07 修）
    expect(attachmentCapabilityIssue(['text'], [pdf])).toBeNull()
    expect(attachmentCapabilityIssue(null, [pdf])).toBeNull()
  })

  it('空数组（明确声明什么都不支持）也拦', () => {
    expect(attachmentCapabilityIssue([], [image])?.code).toBe('vision')
  })

  it('声明支持 → 没问题', () => {
    expect(attachmentCapabilityIssue(['text', 'image', 'file'], [image, pdf, text])).toBeNull()
  })

  it('只声明了 image：图片放行，PDF 也放行（PDF 走文本提取）', () => {
    expect(attachmentCapabilityIssue(['text', 'image'], [image])).toBeNull()
    expect(attachmentCapabilityIssue(['text', 'image'], [pdf])).toBeNull()
  })

  it('文本类附件**任何模型都放行**（我们自己读出来内联，不依赖模型能力）', () => {
    expect(attachmentCapabilityIssue(['text'], [text])).toBeNull()
    expect(attachmentCapabilityIssue(null, [text])).toBeNull()
  })

  it('媒体类型缺失时靠后缀判（浏览器常给空 type）', () => {
    expect(attachmentCapabilityIssue(['text'], [{ filename: 'a.PNG', mediaType: '' }])).toEqual({
      code: 'vision',
      filename: 'a.PNG',
    })
  })

  it('没有附件时永远没问题', () => {
    expect(attachmentCapabilityIssue(['text'], [])).toBeNull()
    expect(attachmentCapabilityIssue(null, [])).toBeNull()
  })
})

describe('looksLikeImage / looksLikePdf', () => {
  it('媒体类型与后缀任一命中即可', () => {
    expect(looksLikeImage({ filename: 'x', mediaType: 'image/webp' })).toBe(true)
    expect(looksLikeImage({ filename: 'x.jpg', mediaType: '' })).toBe(true)
    expect(looksLikeImage({ filename: 'x.txt', mediaType: 'text/plain' })).toBe(false)
    expect(looksLikePdf({ filename: 'x', mediaType: 'application/pdf' })).toBe(true)
    expect(looksLikePdf({ filename: 'x.PDF', mediaType: '' })).toBe(true)
    expect(looksLikePdf({ filename: 'x.png', mediaType: 'image/png' })).toBe(false)
  })
})
