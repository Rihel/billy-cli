import { describe, expect, it } from 'vitest'
import { CHAT_MESSAGE_MAX_CHARS } from '@repo/shared'
import {
  longTextFileName,
  splitLongText,
} from '../src/app/(app)/(standalone)/main/ai/chat/long-text.ts'

/**
 * 超长消息转附件：`message` 的服务端上限是 8000 字符，超了不该只回一个 400。
 * 这里钉的是"什么时候转、转出来的附件长什么样、正文换成什么"。
 */
describe('splitLongText（超长消息 → 附件）', () => {
  it('未超上限：原样返回（只 trim），不产生附件', () => {
    expect(splitLongText('  你好  ')).toEqual({ content: '你好' })
    expect(splitLongText('a'.repeat(CHAT_MESSAGE_MAX_CHARS)).file).toBeUndefined()
  })

  it('超上限：全文落成 .md 附件，正文换成一句说明', async () => {
    const text = 'a'.repeat(CHAT_MESSAGE_MAX_CHARS + 1)
    const { content, file } = splitLongText(text)

    expect(file).toBeInstanceOf(File)
    expect(file?.name).toMatch(/^长文本-\d{8}-\d{6}\.md$/)
    expect(file?.type).toBe('text/markdown')
    await expect(file!.text()).resolves.toBe(text)

    // 说明里要有字数与文件名，且自身不能再超上限
    expect(content).toContain(String(text.length))
    expect(content).toContain(file!.name)
    expect(content.length).toBeLessThan(CHAT_MESSAGE_MAX_CHARS)
  })

  it('文件名用本地时间戳（同一秒内可复现）', () => {
    expect(longTextFileName(new Date(2026, 10, 14, 0, 15, 30))).toBe('长文本-20261114-001530.md')
  })
})
