import { describe, expect, it } from 'vitest'
import { stripFrontmatter, splitFrontmatter } from '../src/lib/skill-markdown'

/**
 * frontmatter 不进正文 —— 否则 `---` 会被 Markdown 当成 setext 标题，
 * 页面上冒出 `name:` / `description:` 的伪内容（技能编辑器与文件预览都真实踩过）。
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

describe('splitFrontmatter', () => {
  it('name / description 取出，正文与 stripFrontmatter 完全一致', () => {
    const content = '---\nname: lark-cli-setup\ndescription: 装飞书 CLI\n---\n\n# 标题\n'
    expect(splitFrontmatter(content)).toEqual({
      meta: { name: 'lark-cli-setup', description: '装飞书 CLI' },
      body: '\n# 标题\n',
    })
  })

  it('折行块标量（`description: >-`）按空格拼回一段', () => {
    const content = [
      '---',
      'name: lark-cli-setup',
      'description: >-',
      '  用户要在环境里装飞书 CLI、',
      '  配置飞书应用时加载这个技能。',
      'license: MIT',
      '---',
      '正文',
    ].join('\n')
    expect(splitFrontmatter(content).meta).toEqual({
      name: 'lark-cli-setup',
      description: '用户要在环境里装飞书 CLI、 配置飞书应用时加载这个技能。',
      license: 'MIT',
    })
    expect(splitFrontmatter(content).body).toBe('正文')
  })

  it('字面块标量（`|`）保留换行', () => {
    const content = '---\ndescription: |\n  第一行\n  第二行\n---\n正文'
    expect(splitFrontmatter(content).meta.description).toBe('第一行\n第二行')
  })

  it('引号去掉，嵌套结构 / 列表跳过', () => {
    const content = '---\nname: "demo"\ntags:\n  - a\nmetadata:\n  owner: x\n---\n正文'
    expect(splitFrontmatter(content).meta).toEqual({ name: 'demo' })
  })

  it('没有 frontmatter 时 meta 为空、正文原样', () => {
    expect(splitFrontmatter('# 正文\n')).toEqual({ meta: {}, body: '# 正文\n' })
  })
})
