import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { resolveAgentSkills } from '@mastra/core/skills'
import { ALL_SKILLS } from '../src/modules/ai/core/skills/skills.types.js'
import { SkillLoader } from '../src/modules/ai/core/skills/skill.loader.js'
import { toMastraSkills } from '../src/modules/ai/mastra/skill.adapter.js'

/**
 * 技能加载口径：**我们只发现 / 校验 / 授权，正文与参考文件交给 Mastra 按需读**。
 *
 * 这里钉住四件事：
 * 1. 配置的额外目录能被发现（`<目录>/<技能名>/SKILL.md`），按名字取到的是**目录绝对路径**；
 * 2. 多个目录重名时**前面的赢**（catalog > 额外目录 1 > 额外目录 2）；
 * 3. 额外目录里的坏技能只跳过、不抛（用户自带技能库不能绑架启动）；
 * 4. 交给 Mastra 的路径**真能被它加载**（清单 + 按需读 `references/`）—— 这是"用 Mastra 的加载机制"的验收点。
 */

const logger = {
  log: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
} as never

const roots: string[] = []
const makeRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'billy-skills-'))
  roots.push(root)
  return root
}

const writeSkill = (
  root: string,
  name: string,
  options: { description?: string; body?: string; references?: Record<string, string> } = {},
): void => {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  const description = options.description ?? `什么时候用 ${name}`
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\n${options.body ?? `# ${name}\n\n正文。`}\n`)
  for (const [file, content] of Object.entries(options.references ?? {})) {
    mkdirSync(join(dir, 'references'), { recursive: true })
    writeFileSync(join(dir, 'references', file), content)
  }
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

describe('SkillLoader：从配置目录发现技能', () => {
  it('扫到额外目录里的技能，授权拿到的是目录绝对路径', async () => {
    const root = makeRoot()
    writeSkill(root, 'demo-skill', { references: { 'guide.md': '# 指南\n\n长清单。' } })
    writeSkill(root, 'another-skill')

    const loader = new SkillLoader(logger, [root])
    expect((await loader.names()).sort()).toEqual(['another-skill', 'demo-skill'])

    const [skill] = await loader.resolve(['demo-skill'])
    expect(skill).toMatchObject({
      name: 'demo-skill',
      description: '什么时候用 demo-skill',
      path: join(root, 'demo-skill'),
    })
  })

  it('目录不存在不报错（用户没装技能库的常态）', async () => {
    const loader = new SkillLoader(logger, [join(tmpdir(), 'billy-not-exist-dir')])
    expect(await loader.list()).toEqual([])
  })

  it('重名时前面的目录赢，后面那条不生效', async () => {
    const first = makeRoot()
    const second = makeRoot()
    writeSkill(first, 'same-name', { description: '第一个' })
    writeSkill(second, 'same-name', { description: '第二个' })

    const loader = new SkillLoader(logger, [first, second])
    const skills = await loader.list()
    expect(skills).toHaveLength(1)
    expect(skills[0]?.description).toBe('第一个')
    expect((await loader.resolve(['same-name']))[0]?.path).toBe(join(first, 'same-name'))
  })

  it('额外目录里的坏技能只跳过，不影响其余技能（description 超 1024 字符）', async () => {
    const root = makeRoot()
    writeSkill(root, 'good-skill')
    writeSkill(root, 'too-long', { description: 'x'.repeat(1100) })

    const loader = new SkillLoader(logger, [root])
    expect(await loader.names()).toEqual(['good-skill'])
  })

  it('声明了不存在的技能要抛错（装配期失败，不许静默缺技能）', async () => {
    const loader = new SkillLoader(logger, [makeRoot()])
    await expect(loader.resolve(['nope'])).rejects.toThrow(/不存在的技能/)
  })

  it('ALL_SKILLS 展开成全部已发现技能', async () => {
    const root = makeRoot()
    writeSkill(root, 'a')
    writeSkill(root, 'b')

    const loader = new SkillLoader(logger, [root])
    const resolved = await loader.resolve([ALL_SKILLS])
    expect(resolved.map((skill) => skill.name).sort()).toEqual(['a', 'b'])
  })
})

describe('交给 Mastra 的技能路径：清单与按需读都能用', () => {
  it('resolveAgentSkills 能列出技能并读到 references（正文不经过我们的内存）', async () => {
    const root = makeRoot()
    writeSkill(root, 'demo-skill', {
      body: '# demo-skill\n\n第一句正文。\n',
      references: { 'guide.md': '# 指南\n\n这是参考文件。' },
    })

    const loader = new SkillLoader(logger, [root])
    const paths = toMastraSkills(await loader.resolve([ALL_SKILLS]))
    expect(paths).toEqual([join(root, 'demo-skill')])

    const skills = resolveAgentSkills(paths)
    const list = await skills.list()
    expect(list.map((skill) => skill.name)).toEqual(['demo-skill'])

    const loaded = await skills.get('demo-skill')
    expect(loaded?.instructions).toContain('第一句正文')
    // 参考文件由 Mastra 从磁盘按需读（我们不再把它读进内存）：路径相对技能目录
    expect(await skills.getReference('demo-skill', 'references/guide.md')).toContain('这是参考文件')
  })
})
