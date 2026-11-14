import { describe, expect, it } from 'vitest'
import { TITLE_MAX_CHARS, sanitizeTitle } from '../src/modules/ai/runtime/title.service.js'

/**
 * 会话名净化：模型"只输出名字"这条要求**经常做不到**，所以这里钉住的是
 * "它不听话时我们怎么收拾"——五种脏输出各一条，外加码点截断（emoji 不能切成半个）。
 *
 * 这是纯函数单测：真正那次模型调用（隔离性、超时、usage 并账）在 `ai-chat-e2e.test.ts` 里端到端验。
 */
describe('会话名净化（模型输出 → 能直接用的标题）', () => {
  it('正常输出：原样采用', () => {
    expect(sanitizeTitle('待办整理周报')).toBe('待办整理周报')
    expect(sanitizeTitle('缓存穿透排查')).toBe('缓存穿透排查')
  })

  it('先给名字再补解释：只取第一行', () => {
    expect(sanitizeTitle('缓存穿透排查\n这段对话在讨论缓存穿透的成因与规避办法')).toBe(
      '缓存穿透排查',
    )
  })

  it('带引号 / 书名号 / Markdown 前缀 / 序号：都剥掉', () => {
    expect(sanitizeTitle('「缓存穿透排查」')).toBe('缓存穿透排查')
    expect(sanitizeTitle('**待办周报**')).toBe('待办周报')
    expect(sanitizeTitle('1. 待办周报')).toBe('待办周报')
    expect(sanitizeTitle('- 待办周报。')).toBe('待办周报')
    expect(sanitizeTitle('《数据库索引优化》')).toBe('数据库索引优化')
  })

  it('超过 10 个字符：按码点截断（emoji / 生僻字不会被切成半个）', () => {
    const long = '一二三四五六七八九十一二三四五'
    expect(Array.from(sanitizeTitle(long) ?? '')).toHaveLength(TITLE_MAX_CHARS)
    expect(sanitizeTitle(long)).toBe('一二三四五六七八九十')

    // 码点截断：10 个 emoji 应当完整保留（按 UTF-16 slice 会切坏最后一个）
    const emojis = '😀😀😀😀😀😀😀😀😀😀😀😀'
    const title = sanitizeTitle(emojis) ?? ''
    expect(title).toBe('😀😀😀😀😀😀😀😀😀😀')
    expect(title).not.toContain('\uFFFD')
  })

  it('收拾不出东西（空 / 只有标点 / 只有空白）：返回 null，调用方保住兜底标题', () => {
    expect(sanitizeTitle('')).toBeNull()
    expect(sanitizeTitle('   \n  ')).toBeNull()
    expect(sanitizeTitle('""')).toBeNull()
    expect(sanitizeTitle(undefined)).toBeNull()
  })
})
