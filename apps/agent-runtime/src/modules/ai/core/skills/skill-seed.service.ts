import { Inject, Injectable, Optional, type OnApplicationBootstrap } from '@nestjs/common'
import { AppLogger, Db } from '@repo/kits'
import { AiSkillEntity, AiSkillFileEntity } from '@repo/db'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { SKILL_CATALOG_DIR } from './skill.loader.js'

const SKILL_FILE = 'SKILL.md'

export interface CatalogSkill {
  key: string
  title: string
  description: string
  files: { path: string; content: string }[]
}

/** 递归读取一个目录下的文本文件（技能目录都很小；跳过任何非文件） */
const readFiles = (root: string, dir = root): { path: string; content: string }[] => {
  const out: { path: string; content: string }[] = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    const info = statSync(full)
    if (info.isDirectory()) out.push(...readFiles(root, full))
    else if (info.isFile())
      out.push({ path: relative(root, full), content: readFileSync(full, 'utf8') })
  }
  return out
}

/** 从 SKILL.md 里取标题与描述（frontmatter 有就用，没有就取正文首行） */
const metaOf = (markdown: string, fallback: string): { title: string; description: string } => {
  const front = /^---\n([\s\S]*?)\n---/.exec(markdown)?.[1] ?? ''
  const field = (key: string): string | undefined =>
    new RegExp(`^${key}:\\s*(.+)$`, 'm')
      .exec(front)?.[1]
      ?.trim()
      .replace(/^['"]|['"]$/g, '')
  const body = markdown.replace(/^---\n[\s\S]*?\n---/, '').trim()
  const firstLine = body
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith('#') && !line.startsWith('>'))
  return {
    title: field('name') ?? fallback,
    description: field('description') ?? firstLine?.slice(0, 200) ?? fallback,
  }
}

export const readCatalogSkills = (catalogDir: string): CatalogSkill[] => {
  if (!existsSync(catalogDir)) return []
  return readdirSync(catalogDir)
    .filter((name) => statSync(join(catalogDir, name)).isDirectory())
    .flatMap((key) => {
      const dir = join(catalogDir, key)
      if (!existsSync(join(dir, SKILL_FILE))) return []
      const files = readFiles(dir)
      const markdown = files.find((file) => file.path === SKILL_FILE)?.content ?? ''
      const { title, description } = metaOf(markdown, key)
      return [{ key, title, description, files }]
    })
}

/**
 * 内置技能入库（`source='builtin'`、`scope='platform'`）。
 *
 * 为什么必须有这一步：技能目录（提示词）读随包 `catalog/`，而**工作区物化**读 DB —— 两边不同步时，
 * 模型被告知"先加载 html-page"，工作区里却没有这个文件（2026-11-21 实际踩到）。
 * 启动时 upsert，DB 成为唯一事实源；目录里的技能文件更新后重启即生效。
 */
@Injectable()
export class SkillSeedService implements OnApplicationBootstrap {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(AppLogger) private readonly logger: AppLogger,
    @Optional() @Inject(SKILL_CATALOG_DIR) private readonly catalogDir?: string,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const dir = this.catalogDir ?? join(import.meta.dirname, 'catalog')
    const skills = readCatalogSkills(dir)
    if (skills.length === 0) return
    const skillRepo = this.db.getRepository(AiSkillEntity)
    const fileRepo = this.db.getRepository(AiSkillFileEntity)
    let created = 0
    let updated = 0
    for (const skill of skills) {
      const existing = await skillRepo.findOne({
        where: { skillKey: skill.key, scope: 'platform' },
      })
      const entity = existing
        ? await skillRepo.save(
            skillRepo.merge(existing, {
              title: skill.title,
              description: skill.description,
              enabled: true,
              source: 'builtin',
              lastValidatedAt: new Date(),
            }),
          )
        : await skillRepo.save(
            skillRepo.create({
              skillKey: skill.key,
              title: skill.title,
              description: skill.description,
              enabled: true,
              source: 'builtin',
              scope: 'platform',
              lastValidatedAt: new Date(),
            }),
          )
      await fileRepo.delete({ skillId: entity.id })
      for (const file of skill.files) {
        await fileRepo.save(
          fileRepo.create({ skillId: entity.id, path: file.path, content: file.content }),
        )
      }
      if (existing) updated += 1
      else created += 1
    }
    this.logger.log('ai.skill.seeded', { created, updated, catalogDir: dir })
  }
}
