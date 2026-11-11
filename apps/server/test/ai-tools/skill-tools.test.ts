import { describe, expect, it, vi } from 'vitest'
import { ToolDeniedError } from '../../src/modules/ai/core/tools/tools.types.js'
import { TOOL_KEYS } from '../../src/modules/ai/core/tools/tool-keys.js'
import { SkillTools } from '../../src/modules/ai/skills/skill.tools.js'
import { specByKey } from '../helpers/ai-tool-stack.js'

/**
 * 技能库工具组（`skill-list` / `skill-save` / `skill-delete` / `skill-enable`）。
 *
 * 只钉**编排**：工具本身不该有业务逻辑（校验 / 落盘 / 乐观锁都在 `SkillLibraryService`），
 * 它负责的是"新建还是更新"的判断、把正文与文件按顺序写进去、以及把异常翻译成模型能改的结论。
 */
const detailOf = (version: number, files: string[] = ['SKILL.md']) => ({
  skillKey: 'demo-skill',
  version,
  enabled: true,
  files: files.map((path) => ({ path, kind: 'markdown', size: 1 })),
})

const makeService = () => ({
  list: vi.fn(),
  detail: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  saveFile: vi.fn(),
  readFile: vi.fn(),
  remove: vi.fn(),
  import: vi.fn(),
})

const makeGroup = (service: ReturnType<typeof makeService>) =>
  new SkillTools(service as never)

describe('skill-save：新建 / 更新', () => {
  it('不存在 → 一次 create（正文 + 参考文件一起写）', async () => {
    const service = makeService()
    service.detail.mockRejectedValueOnce(new Error('技能不存在'))
    service.create.mockResolvedValue(detailOf(1, ['SKILL.md', 'references/a.md']))
    const spec = specByKey(makeGroup(service), TOOL_KEYS.skillSave)

    const result = (await spec.exec(
      {
        skillKey: 'demo-skill',
        description: '什么时候用',
        body: '# 正文',
        files: [{ path: 'references/a.md', content: 'A' }],
      },
      {} as never,
    )) as { created: boolean; version: number }

    expect(result.created).toBe(true)
    expect(result.version).toBe(1)
    expect(service.create).toHaveBeenCalledWith(
      expect.objectContaining({
        skillKey: 'demo-skill',
        body: '# 正文',
        files: [{ path: 'references/a.md', content: 'A' }],
      }),
    )
    expect(service.saveFile).not.toHaveBeenCalled()
  })

  it('已存在 → update 元信息，再按顺序写 SKILL.md 与 files（版本逐次传递）', async () => {
    const service = makeService()
    service.detail.mockResolvedValue(detailOf(2))
    service.update.mockResolvedValue(detailOf(3))
    service.saveFile
      .mockResolvedValueOnce(detailOf(4, ['SKILL.md']))
      .mockResolvedValueOnce(detailOf(5, ['SKILL.md', 'scripts/run.py']))
    const spec = specByKey(makeGroup(service), TOOL_KEYS.skillSave)

    const result = (await spec.exec(
      {
        skillKey: 'demo-skill',
        description: '新的时机',
        body: '# 新正文',
        files: [{ path: 'scripts/run.py', content: 'print(1)' }],
      },
      {} as never,
    )) as { created: boolean; version: number }

    expect(result).toMatchObject({ created: false, version: 5 })
    expect(service.update).toHaveBeenCalledWith(
      expect.objectContaining({ skillKey: 'demo-skill', description: '新的时机', expectedVersion: 2 }),
    )
    expect(service.saveFile).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ path: 'SKILL.md', content: '# 新正文', expectedVersion: 3 }),
    )
    expect(service.saveFile).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ path: 'scripts/run.py', expectedVersion: 4 }),
    )
  })

  it('服务层报错 → 翻译成 ToolDeniedError（模型能读懂、可纠正）', async () => {
    const service = makeService()
    service.detail.mockRejectedValueOnce(new Error('不存在'))
    service.create.mockRejectedValue(new Error('技能内容不合法：description 过长'))
    const spec = specByKey(makeGroup(service), TOOL_KEYS.skillSave)

    await expect(
      spec.exec(
        { skillKey: 'demo-skill', description: 'x', body: '' },
        {} as never,
      ),
    ).rejects.toBeInstanceOf(ToolDeniedError)
  })
})

describe('skill-file-save / skill-file-append', () => {
  it('skill-file-save 直接写单个参考文件，不带整篇正文', async () => {
    const service = makeService()
    service.saveFile.mockResolvedValue(detailOf(4, ['SKILL.md', 'references/a.md']))
    const spec = specByKey(makeGroup(service), TOOL_KEYS.skillFileSave)

    const result = (await spec.exec(
      { skillKey: 'demo-skill', path: 'references/a.md', content: 'A', expectedVersion: 3 },
      {} as never,
    )) as { ok: boolean; version: number; files: string[] }

    expect(result).toMatchObject({ ok: true, version: 4 })
    expect(service.saveFile).toHaveBeenCalledWith({
      skillKey: 'demo-skill',
      path: 'references/a.md',
      content: 'A',
      expectedVersion: 3,
    })
  })

  it('skill-file-append 先读旧内容再追加，expectedVersion 用当前版本', async () => {
    const service = makeService()
    service.readFile.mockResolvedValue({
      path: 'references/a.md',
      kind: 'markdown',
      content: 'A',
      version: 3,
    })
    service.saveFile.mockResolvedValue(detailOf(4, ['SKILL.md', 'references/a.md']))
    const spec = specByKey(makeGroup(service), TOOL_KEYS.skillFileAppend)

    const result = (await spec.exec(
      { skillKey: 'demo-skill', path: 'references/a.md', content: 'BC' },
      {} as never,
    )) as { bytes: number; version: number }

    expect(result).toMatchObject({ bytes: 3, version: 4 })
    expect(service.saveFile).toHaveBeenCalledWith({
      skillKey: 'demo-skill',
      path: 'references/a.md',
      content: 'ABC',
      expectedVersion: 3,
    })
  })

  it('SKILL.md 不走文件工具，必须用 skill-save', async () => {
    const service = makeService()
    const spec = specByKey(makeGroup(service), TOOL_KEYS.skillFileSave)
    await expect(
      spec.exec({ skillKey: 'demo-skill', path: 'SKILL.md', content: 'x' }, {} as never),
    ).rejects.toBeInstanceOf(ToolDeniedError)
    expect(service.saveFile).not.toHaveBeenCalled()
  })
})

describe('skill-list / skill-delete / skill-enable', () => {
  it('skill-list 只回模型需要的摘要字段', async () => {
    const service = makeService()
    service.list.mockResolvedValue({
      items: [{ ...detailOf(3), title: 'Demo', description: '时机', source: 'online', fileCount: 2 }],
      total: 1,
      page: 1,
      size: 100,
    })
    const spec = specByKey(makeGroup(service), TOOL_KEYS.skillList)
    const result = (await spec.exec({ enabledOnly: true }, {} as never)) as {
      total: number
      items: Record<string, unknown>[]
    }
    expect(result.total).toBe(1)
    expect(result.items[0]).toEqual({
      skillKey: 'demo-skill',
      title: 'Demo',
      description: '时机',
      enabled: true,
      source: 'online',
      fileCount: 2,
      version: 3,
    })
    expect(service.list).toHaveBeenCalledWith(expect.objectContaining({ enabled: true }))
  })

  it('skill-enable 直接走 update（不碰文件）', async () => {
    const service = makeService()
    service.update.mockResolvedValue({ ...detailOf(3), enabled: false })
    const spec = specByKey(makeGroup(service), TOOL_KEYS.skillEnable)
    const result = (await spec.exec({ skillKey: 'demo-skill', enabled: false }, {} as never)) as {
      enabled: boolean
    }
    expect(result.enabled).toBe(false)
    expect(service.update).toHaveBeenCalledWith({ skillKey: 'demo-skill', enabled: false })
  })

  it('skill-import 把链接交给 service（覆盖开关一起传）', async () => {
    const service = makeService()
    service.import.mockResolvedValue({ source: 'vercel-labs/skills', items: [], total: 0 })
    const spec = specByKey(makeGroup(service), TOOL_KEYS.skillImport)

    await expect(
      spec.exec(
        { url: 'https://skills.sh/vercel-labs/skills/find-skills', overwrite: true },
        {} as never,
      ),
    ).resolves.toMatchObject({ source: 'vercel-labs/skills' })
    expect(service.import).toHaveBeenCalledWith({
      url: 'https://skills.sh/vercel-labs/skills/find-skills',
      overwrite: true,
    })
  })

  it('skill-delete 调 remove', async () => {
    const service = makeService()
    service.remove.mockResolvedValue({ ok: true })
    const spec = specByKey(makeGroup(service), TOOL_KEYS.skillDelete)
    await expect(
      spec.exec({ skillKey: 'demo-skill' }, {} as never),
    ).resolves.toMatchObject({ ok: true })
  })
})
