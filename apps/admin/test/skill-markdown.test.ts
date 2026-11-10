import { describe, expect, it } from 'vitest'
import { stripFrontmatter } from '../src/lib/skill-markdown'

/**
 * `SKILL.md` 进块编辑器前必须去掉 frontmatter —— 否则 `---` 会把 YAML 解析成 setext 标题，
 * 编辑器里出现 `name:` / `description:` 的伪内容（真实踩过）。
 */
describe('stripFrontmatter', () => {
  it('去掉标准 frontmatter，只留正文', () => {
    const content = '---\nname: demo\ndescription: 什么时候用\n---\n\n# 正文\n\n第一段。\n'
    expect(stripFrontmatter(content)).toBe('\n# 正文\n\n第一段。\n')
  })

  it('兼容 CRLF 与没有尾随空行', () => {
    expect(stripFrontmatter('---\r\nname: demo\r\ndescription: x\r\n---\r\n正文')).toBe('正文')
  })

  it('没有 frontmatter 时原样返回', () => {
    expect(stripFrontmatter('# 正文\n')).toBe('# 正文\n')
  })

  it('frontmatter 里出现 `---` 字样也能正确切到第一个结束标记', () => {
    const content = '---\nname: demo\ndescription: 用 --- 分隔\n---\n\n正文\n'
    expect(stripFrontmatter(content)).toBe('\n正文\n')
  })
})
