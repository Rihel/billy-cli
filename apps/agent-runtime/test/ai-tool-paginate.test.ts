import { describe, expect, it } from 'vitest'
import {
  makePageHandle,
  paginate,
  parsePageHandle,
  serializeToolValue,
  toModelPage,
} from '../src/modules/ai/core/tools/paginate.js'

/**
 * 分页纯函数（设计 §5.6）。
 *
 * 三条硬约束钉在这里：
 * 1. **确定性**：同一 handle + 同一 page 必须给同一段内容（durable 恢复重放要一致）；
 * 2. **按字节切**，且**不切碎多字节字符**（页尾不能出现半个汉字）；
 * 3. 页头如实（`totalBytes` / `totalPages` / `hasMore` 与实际一致）。
 */
describe('工具出参分页（纯函数）', () => {
  it('序列化口径：undefined 归一成 null（否则 JSON.stringify 返回 undefined）', () => {
    expect(serializeToolValue(undefined)).toBe('null')
    expect(serializeToolValue({ a: 1 })).toBe('{"a":1}')
  })

  it('句柄：拼得出、解得回；格式不对返回 null', () => {
    const handle = makePageHandle('conv-1', 'call-1')
    expect(parsePageHandle(handle)).toEqual({ conversationId: 'conv-1', toolCallId: 'call-1' })
    expect(parsePageHandle('bogus')).toBeNull()
    expect(parsePageHandle('tr:only-two')).toBeNull()
  })

  it('刚好一页：hasMore=false，内容就是全文', () => {
    const text = 'x'.repeat(100)
    const page = paginate(text, 100, 1, 'h')
    expect(page.content).toBe(text)
    expect(page.meta).toMatchObject({ page: 1, totalBytes: 100, totalPages: 1, hasMore: false })
  })

  it('多页：每页内容拼起来等于原文（逐字节无损）', () => {
    const text = Array.from({ length: 250 }, (_, index) =>
      String.fromCharCode(97 + (index % 26)),
    ).join('')
    const pageBytes = 32
    const total = paginate(text, pageBytes, 1, 'h').meta.totalPages
    let joined = ''
    for (let page = 1; page <= total; page += 1) {
      joined += paginate(text, pageBytes, page, 'h').content
    }
    expect(joined).toBe(text)
  })

  it('确定性：同一 handle + 同一 page 跑两次，内容与页头逐字节一致', () => {
    const text = 'x'.repeat(500)
    const first = paginate(text, 64, 3, 'h')
    const second = paginate(text, 64, 3, 'h')
    expect(second).toEqual(first)
  })

  it('多字节字符不被切碎：每页都能被 UTF-8 正确解码，且拼起来等于原文', () => {
    const text = '汉'.repeat(30)
    const pageBytes = 7 // 一个汉字 3 字节 → 每页最多 2 个字
    const total = paginate(text, pageBytes, 1, 'h').meta.totalPages
    let joined = ''
    for (let page = 1; page <= total; page += 1) {
      const content = paginate(text, pageBytes, page, 'h').content
      expect(content).not.toContain('\uFFFD') // 没有替换字符 = 没切碎
      joined += content
    }
    expect(joined).toBe(text)
  })

  it('空出参：一页、内容为空、hasMore=false', () => {
    const page = paginate('', 64, 1, 'h')
    expect(page.content).toBe('')
    expect(page.meta).toMatchObject({ totalBytes: 0, totalPages: 1, hasMore: false })
  })

  it('页码越界：夹到 [1, totalPages]（模型传 99 也不炸）', () => {
    const text = 'x'.repeat(100)
    expect(paginate(text, 50, 99, 'h').meta.page).toBe(2)
    expect(paginate(text, 50, 0, 'h').meta.page).toBe(1)
  })

  it('给模型的那一份：带页头 + 本页内容，还有下一页时给取页提示', () => {
    const text = 'x'.repeat(100)
    const withMore = toModelPage(paginate(text, 50, 1, 'h'))
    expect(withMore.page).toMatchObject({ page: 1, totalPages: 2, hasMore: true })
    expect(String(withMore.next)).toContain('read-tool-result')
    const last = toModelPage(paginate(text, 50, 2, 'h'))
    expect(last.next).toBeUndefined()
  })
})
