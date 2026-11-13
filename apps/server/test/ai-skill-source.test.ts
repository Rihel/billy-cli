import { describe, expect, it } from 'vitest'
import { describeSkillSource, parseSkillSource } from '../src/modules/ai/skills/skill.source.js'

/**
 * 链接解析：把用户粘贴的各种来源归一成「GitHub owner/repo[/ref][/subpath][/slug]」或直接 Markdown。
 *
 * 这是导入的第一道门：解析错了要么导错技能，要么把整仓都灌进来。所以形态逐个钉住。
 */
describe('parseSkillSource', () => {
  it('skills.sh 技能页 → GitHub owner/repo + slug', () => {
    expect(parseSkillSource('https://skills.sh/vercel-labs/skills/find-skills')).toEqual({
      kind: 'github',
      owner: 'vercel-labs',
      repo: 'skills',
      slug: 'find-skills',
    })
    expect(
      parseSkillSource('https://www.skills.sh/anthropics/skills/frontend-design'),
    ).toMatchObject({
      owner: 'anthropics',
      repo: 'skills',
      slug: 'frontend-design',
    })
  })

  it('skills.sh 仓库首页 → 不带 slug（整仓）', () => {
    expect(parseSkillSource('https://skills.sh/vercel-labs/skills')).toEqual({
      kind: 'github',
      owner: 'vercel-labs',
      repo: 'skills',
    })
  })

  it('GitHub 目录链接 → ref + subpath', () => {
    expect(
      parseSkillSource('https://github.com/vercel-labs/skills/tree/main/skills/find-skills'),
    ).toEqual({
      kind: 'github',
      owner: 'vercel-labs',
      repo: 'skills',
      ref: 'main',
      subpath: 'skills/find-skills',
    })
  })

  it('GitHub 文件链接 → 技能目录', () => {
    expect(
      parseSkillSource(
        'https://github.com/vercel-labs/skills/blob/main/skills/find-skills/SKILL.md',
      ),
    ).toEqual({
      kind: 'github',
      owner: 'vercel-labs',
      repo: 'skills',
      ref: 'main',
      subpath: 'skills/find-skills',
    })
  })

  it('raw 链接 → ref + 技能目录', () => {
    expect(
      parseSkillSource(
        'https://raw.githubusercontent.com/vercel-labs/skills/main/skills/find-skills/SKILL.md',
      ),
    ).toEqual({
      kind: 'github',
      owner: 'vercel-labs',
      repo: 'skills',
      ref: 'main',
      subpath: 'skills/find-skills',
    })
  })

  it('简写 owner/repo[/slug]', () => {
    expect(parseSkillSource('vercel-labs/skills')).toEqual({
      kind: 'github',
      owner: 'vercel-labs',
      repo: 'skills',
    })
    expect(parseSkillSource('vercel-labs/skills/find-skills')).toMatchObject({
      slug: 'find-skills',
    })
    expect(parseSkillSource('vercel-labs/skills.git')).toMatchObject({ repo: 'skills' })
  })

  it('其它站点的 .md 链接 → 单文件技能', () => {
    expect(parseSkillSource('https://example.com/path/my-skill.md')).toEqual({
      kind: 'markdown',
      url: 'https://example.com/path/my-skill.md',
    })
    // 查询串 / hash 不影响解析
    expect(parseSkillSource('https://example.com/my.md?raw=1#x')).toMatchObject({
      kind: 'markdown',
    })
  })

  it('不支持的来源给出可执行的提示', () => {
    expect(() => parseSkillSource('https://skills.sh/p/some-pack')).toThrow(/Pack/)
    expect(() => parseSkillSource('https://skills.sh/site/uizze.sh/ui-taste')).toThrow(/第三方站点/)
    expect(() => parseSkillSource('https://example.com/owner/repo')).toThrow(/不支持的来源/)
    expect(() => parseSkillSource('not a source')).toThrow(/看不懂/)
    expect(() => parseSkillSource('')).toThrow(/请填写/)
  })

  it('describeSkillSource 给的是人读来源', () => {
    expect(
      describeSkillSource(
        parseSkillSource('https://github.com/vercel-labs/skills/tree/main/skills/find-skills'),
      ),
    ).toBe('vercel-labs/skills/skills/find-skills')
    expect(describeSkillSource(parseSkillSource('https://example.com/a.md'))).toContain('直接链接')
  })
})
