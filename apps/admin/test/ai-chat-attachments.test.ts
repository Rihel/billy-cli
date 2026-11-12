import { describe, expect, it } from 'vitest'
import { CHAT_ATTACHMENT_MAX_BYTES, CHAT_ATTACHMENT_MAX_COUNT } from '@repo/shared'
import {
  ATTACHMENT_ACCEPT,
  formatFileSize,
  isAcceptableFile,
  isImageAttachment,
  isInlineTextAttachment,
  isWithinSizeLimit,
  rejectReasonOf,
  toAttachmentPayload,
} from '../src/app/(app)/(standalone)/main/ai/chat/attachment-utils.ts'
import { rejectedText, scanFiles } from '../src/app/(app)/(standalone)/main/ai/chat/use-attachments-upload.ts'

/**
 * 前端附件预检：**在提交之前**把不合格的东西说清楚。
 *
 * 钉住的口径（每一条都对应一种用户会踩的坑）：
 * 1. 超过 2MB 不收（服务端也拦，但那时输入框已经清空了）；
 * 2. 类型不在清单里不收（粘贴不走 `accept` 属性，必须自己判）；
 * 3. 一轮最多 3 个（与后端 schema 的 `.max()` 同一个常量）；
 * 4. 提示要**逐个文件说清原因**，不能只说一句"失败"。
 */

/** 造一个指定大小与类型的文件（只用到 name / type / size，不必真有内容） */
const fileOf = (name: string, type: string, size: number): File => {
  const file = new File([''], name, { type })
  Object.defineProperty(file, 'size', { value: size })
  return file
}

describe('formatFileSize', () => {
  it('按 1024 进制显示，单位递进', () => {
    expect(formatFileSize(512)).toBe('512 B')
    expect(formatFileSize(2048)).toBe('2.0 KB')
    expect(formatFileSize(2 * 1024 * 1024)).toBe('2.00 MB')
  })
})

describe('附件类型判据', () => {
  it('图片按媒体类型或后缀都认得出', () => {
    expect(isImageAttachment('a.png', 'image/png')).toBe(true)
    expect(isImageAttachment('a.webp', '')).toBe(true)
    expect(isImageAttachment('a.pdf', 'application/pdf')).toBe(false)
  })

  it('文本类：`text/*` 与已知后缀都算（会被内联进提示词）', () => {
    expect(isInlineTextAttachment('a.txt', 'text/plain')).toBe(true)
    expect(isInlineTextAttachment('a.md', 'application/octet-stream')).toBe(true)
    expect(isInlineTextAttachment('a.csv', 'application/octet-stream')).toBe(true)
    expect(isInlineTextAttachment('a.png', 'image/png')).toBe(false)
  })

  it('允许清单里既有图片也有 PDF 与文本', () => {
    expect(ATTACHMENT_ACCEPT).toContain('image/png')
    expect(ATTACHMENT_ACCEPT).toContain('application/pdf')
    expect(ATTACHMENT_ACCEPT).toContain('text/csv')
  })
})

describe('rejectReasonOf', () => {
  it('合格的文件不给理由', () => {
    expect(rejectReasonOf(fileOf('a.png', 'image/png', 1024))).toBeNull()
    expect(rejectReasonOf(fileOf('a.md', 'text/markdown', 1024))).toBeNull()
  })

  it('超过 2MB → 说明是哪个文件、多大', () => {
    const reason = rejectReasonOf(fileOf('big.png', 'image/png', CHAT_ATTACHMENT_MAX_BYTES + 1))
    expect(reason).toContain('big.png')
    expect(reason).toContain('2MB')
  })

  it('类型不在清单里 → 说明是哪个文件', () => {
    const reason = rejectReasonOf(fileOf('app.exe', 'application/x-msdownload', 1024))
    expect(reason).toContain('app.exe')
    expect(reason).toContain('不是支持的格式')
  })

  it('空文件当作超限（0 字节没有意义，按不合格处理）', () => {
    expect(isWithinSizeLimit(fileOf('empty.png', 'image/png', 0))).toBe(false)
  })
})

describe('scanFiles', () => {
  it('能收的与不能收的分开报，且**保留顺序**', () => {
    const result = scanFiles([
      fileOf('a.png', 'image/png', 1024),
      fileOf('b.exe', 'application/x-msdownload', 1024),
      fileOf('c.txt', 'text/plain', 2048),
    ])

    expect(result.accepted.map((file) => file.name)).toEqual(['a.png', 'c.txt'])
    expect(result.rejected).toHaveLength(1)
    expect(result.rejected[0]).toContain('b.exe')
  })

  it('数量超限**不算"不合格文件"**（数量由调用方整轮拦下，不能在这里偷偷砍掉多余的）', () => {
    const files = Array.from({ length: CHAT_ATTACHMENT_MAX_COUNT + 2 }, (_, index) =>
      fileOf(`f${index}.png`, 'image/png', 1024),
    )
    const result = scanFiles(files)

    // 五个都合格：砍掉会把"用户选中的文件"变成"我觉得该带几个"
    expect(result.accepted).toHaveLength(CHAT_ATTACHMENT_MAX_COUNT + 2)
    expect(result.rejected).toHaveLength(0)
  })

  it('模型明确只收文本：图片被拦下并说明原因（换模型或去掉它）', () => {
    const result = scanFiles(
      [fileOf('shot.png', 'image/png', 1024), fileOf('note.md', 'text/markdown', 1024)],
      ['text'],
    )

    expect(result.accepted.map((file) => file.name)).toEqual(['note.md'])
    expect(result.rejected[0]).toContain('shot.png')
    expect(result.rejected[0]).toContain('不支持图片输入')
  })

  it('**PDF 不再被"文件输入"能力拦下**（服务端会抽文字层内联，任何模型都能读）', () => {
    const result = scanFiles(
      [fileOf('doc.pdf', 'application/pdf', 1024), fileOf('shot.png', 'image/png', 1024)],
      ['text', 'image'],
    )

    // 2026-10-07 修：PDF 走文本提取，不该因为模型没声明 `file` 就被拒；
    // 真正需要"文件输入"能力的只有"抽不出文字层的扫描件"，那一步在服务端读文件时判
    expect(result.accepted.map((file) => file.name)).toEqual(['doc.pdf', 'shot.png'])
    expect(result.rejected).toHaveLength(0)
  })

  it('只收文本的模型：图片仍被拦（放宽的只有 PDF，图片判据不变）', () => {
    const result = scanFiles([fileOf('shot.png', 'image/png', 1024)], ['text'])
    expect(result.accepted).toHaveLength(0)
    expect(result.rejected[0]).toContain('不支持图片输入')
  })

  it('**未声明（null）时一律放行**，只在会话页提醒（国内厂商普遍不给模态）', () => {
    const result = scanFiles([fileOf('shot.png', 'image/png', 1024)], null)
    expect(result.accepted).toHaveLength(1)
    expect(result.rejected).toHaveLength(0)
  })

  it('**清单还没到手（undefined）时也放行**，让服务端判', () => {
    const result = scanFiles([fileOf('shot.png', 'image/png', 1024)], undefined)
    expect(result.accepted).toHaveLength(1)
    expect(result.rejected).toHaveLength(0)
  })

  it('全都不合格时 accepted 为空（调用方据此整轮不发）', () => {
    const result = scanFiles([fileOf('a.exe', 'application/x-msdownload', 1024)])
    expect(result.accepted).toHaveLength(0)
    expect(result.rejected).toHaveLength(1)
  })
})

describe('rejectedText', () => {
  it('少量原因全部列出', () => {
    expect(rejectedText(['a 不行', 'b 不行'])).toBe('a 不行；b 不行')
  })

  it('原因多时只列前三条，其余折叠成数量', () => {
    const text = rejectedText(['1', '2', '3', '4', '5'])
    expect(text).toContain('1；2；3')
    expect(text).toContain('等 5 个文件')
  })
})

describe('toAttachmentPayload', () => {
  it('把已上传的附件整理成请求体形状（key + 元数据，不带文件内容）', () => {
    const file = fileOf('shot.png', 'image/png', 2048)
    const payload = toAttachmentPayload([{ key: 'abc.png', file }])

    expect(payload).toEqual([
      { key: 'abc.png', filename: 'shot.png', mediaType: 'image/png', bytes: 2048 },
    ])
  })
})

describe('isAcceptableFile', () => {
  it('媒体类型缺失时按后缀放行（浏览器常给空 type）', () => {
    expect(isAcceptableFile(fileOf('a.md', '', 1024))).toBe(true)
    expect(isAcceptableFile(fileOf('a.pdf', '', 1024))).toBe(true)
    expect(isAcceptableFile(fileOf('a.zip', '', 1024))).toBe(false)
  })
})
