import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { readCatalogSkills } from '../src/modules/ai/core/skills/skill-seed.service.js'

/** 内置技能入库：至少要把随包 catalog 里的技能与文件完整读出来 */
describe('readCatalogSkills', () => {
  it('读到 html-page，且包含 SKILL.md 正文', () => {
    const dir = join(import.meta.dirname, '../src/modules/ai/core/skills/catalog')
    const skills = readCatalogSkills(dir)
    const htmlPage = skills.find((skill) => skill.key === 'html-page')
    expect(htmlPage).toBeDefined()
    expect(
      htmlPage!.files.some((file) => file.path === 'SKILL.md' && file.content.length > 0),
    ).toBe(true)
  })
})
