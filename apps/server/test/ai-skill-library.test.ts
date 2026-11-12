import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  normalizeSkillFilePath,
  resolveSkillFilePath,
  skillDirOf,
} from '../src/modules/ai/core/skills/skill.paths.js'
import {
  buildSkillMarkdown,
  parseSkillMarkdown,
  validateSkillDraft,
} from '../src/modules/ai/core/skills/skill.draft.js'
import { SkillMaterializer } from '../src/modules/ai/core/skills/skill.materializer.js'
import { SkillLoader } from '../src/modules/ai/core/skills/skill.loader.js'

/**
 * 技能库的纯逻辑验收：**路径白名单 / 草稿校验 / 落盘 / 加载**。
 *
 * 这四块是"在线写技能"最容易出错的地方（越界写盘、frontmatter 往返、停用后目录残留、
 * 新建后 loader 还拿着旧名单），所以脱离 HTTP 与数据库单独钉住。
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
  const root = mkdtempSync(join(tmpdir(), 'billy-skill-lib-'))
  roots.push(root)
  return root
}

/** 不存在的内置技能目录：这里验的是技能库语义，不能被随包发布的 `catalog/` 干扰 */
const NO_CATALOG = join(tmpdir(), 'billy-no-catalog')

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

describe('技能文件路径：白名单 + 越界防御', () => {
  it('接受 SKILL.md 与 references/scripts/assets 下的普通文件', () => {
    expect(normalizeSkillFilePath('SKILL.md')).toBe('SKILL.md')
    expect(normalizeSkillFilePath('references/check-list.md')).toBe('references/check-list.md')
    expect(normalizeSkillFilePath('scripts/run.py')).toBe('scripts/run.py')
    expect(normalizeSkillFilePath('assets/a/b_1.txt')).toBe('assets/a/b_1.txt')
  })

  it('拒绝绝对路径 / 反斜杠 / 越界段 / 白名单外的目录', () => {
    for (const path of [
      '/etc/passwd',
      'references\\a.md',
      '../a.md',
      'references/../a.md',
      'references/../../a.md',
      'templates/a.md',
      'README.md',
      '',
    ]) {
      expect(() => normalizeSkillFilePath(path)).toThrow()
    }
  })

  it('落盘路径解析后仍在技能目录内（纵深防御）', () => {
    const root = makeRoot()
    expect(resolveSkillFilePath(root, 'demo', 'references/a.md')).toBe(
      join(root, 'demo', 'references', 'a.md'),
    )
    // 绕过 normalize 直接传穿越路径也必须被挡住
    expect(() => resolveSkillFilePath(root, 'demo', 'references/../../../etc/passwd')).toThrow()
    expect(skillDirOf(root, 'demo')).toBe(join(root, 'demo'))
  })
})

describe('SKILL.md 草稿：拼装 / 解析 / 校验', () => {
  it('frontmatter 的额外字段能往返（name / description 以入参为准）', () => {
    const draft = {
      skillKey: 'demo-skill',
      description: '什么时候用 demo',
      frontmatter: { license: 'MIT', metadata: { owner: 'billy' }, name: '被覆盖' },
      body: '# demo\n\n第一段。\n',
    }
    const validation = validateSkillDraft(draft)
    expect(validation.valid).toBe(true)
    expect(validation.content.startsWith('---\n')).toBe(true)

    const parsed = parseSkillMarkdown(validation.content, 'demo-skill')
    expect(parsed.parsed?.skillKey).toBe('demo-skill')
    expect(parsed.parsed?.description).toBe('什么时候用 demo')
    expect(parsed.parsed?.frontmatter.license).toBe('MIT')
    expect(parsed.parsed?.frontmatter.name).toBeUndefined()
    expect(parsed.parsed?.body).toContain('第一段。')
  })

  it('description 超过 1024 字符被 Mastra 校验拦下（不写库）', () => {
    const validation = validateSkillDraft({
      skillKey: 'too-long',
      description: 'x'.repeat(1100),
      frontmatter: {},
      body: '',
    })
    expect(validation.valid).toBe(false)
    expect(validation.errors.join(' ')).toMatch(/description/i)
  })

  it('名字与目录不一致时解析失败', () => {
    const content = buildSkillMarkdown({
      skillKey: 'name-a',
      description: 'x',
      frontmatter: {},
      body: '',
    })
    expect(parseSkillMarkdown(content, 'name-b').parsed).toBeNull()
  })
})

describe('落盘：写全量 / 删旧文件 / 清孤儿目录', () => {
  it('sync 写入全部文件；再次 sync 会删掉不在集合里的旧文件', async () => {
    const root = makeRoot()
    const materializer = new SkillMaterializer(logger, root)

    await materializer.sync({
      skillKey: 'demo',
      files: [
        { path: 'SKILL.md', content: '# demo\n' },
        { path: 'references/a.md', content: 'A' },
        { path: 'scripts/run.py', content: 'print(1)' },
      ],
    })
    expect(readFileSync(join(root, 'demo', 'references', 'a.md'), 'utf8')).toBe('A')
    expect(existsSync(join(root, 'demo', 'scripts', 'run.py'))).toBe(true)

    await materializer.sync({
      skillKey: 'demo',
      files: [{ path: 'SKILL.md', content: '# demo\n' }],
    })
    expect(existsSync(join(root, 'demo', 'references'))).toBe(false)
    expect(existsSync(join(root, 'demo', 'SKILL.md'))).toBe(true)
  })

  it('remove 删掉技能目录；syncAll 会清掉库里不存在的目录', async () => {
    const root = makeRoot()
    const materializer = new SkillMaterializer(logger, root)

    await materializer.sync({ skillKey: 'keep', files: [{ path: 'SKILL.md', content: 'k' }] })
    await materializer.sync({ skillKey: 'drop', files: [{ path: 'SKILL.md', content: 'd' }] })

    await materializer.syncAll([{ skillKey: 'keep', files: [{ path: 'SKILL.md', content: 'k' }] }])
    expect(existsSync(join(root, 'drop'))).toBe(false)
    expect(existsSync(join(root, 'keep'))).toBe(true)

    await materializer.remove('keep')
    expect(existsSync(join(root, 'keep'))).toBe(false)
  })
})

describe('SkillLoader：技能库目录 + reload', () => {
  it('新建技能后 reload 能看到它；技能库优先于外部目录', async () => {
    const library = makeRoot()
    const external = makeRoot()

    writeExternalSkill(external, 'demo', '外部版本')
    writeExternalSkill(library, 'demo', '库版本')

    const loader = new SkillLoader(logger, [external], library, NO_CATALOG)
    const skills = await loader.list()
    expect(skills).toHaveLength(1)
    // 库目录排在外部目录前面：后台里启用的技能赢
    expect(skills[0]?.description).toBe('库版本')

    // 在线新建：落盘后 reload 立刻可见
    mkdirSync(join(library, 'new-skill'), { recursive: true })
    writeFileSync(
      join(library, 'new-skill', 'SKILL.md'),
      '---\nname: new-skill\ndescription: 新建的\n---\n\n正文\n',
    )
    expect(await loader.names()).toEqual(['demo'])
    loader.reload()
    expect((await loader.names()).sort()).toEqual(['demo', 'new-skill'])
  })
})

const writeExternalSkill = (root: string, name: string, description: string): void => {
  mkdirSync(join(root, name), { recursive: true })
  writeFileSync(
    join(root, name, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n正文\n`,
  )
}
