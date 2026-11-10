import { Inject, Injectable } from '@nestjs/common'
import { Db, pageWith, type PageQueryResult } from '@repo/kits'
import type { AiSkillListDto } from '@repo/shared'
import type { EntityManager } from 'typeorm'
import { In } from 'typeorm'
import { AiSkillEntity } from '../../../database/entities/ai-skill-entity.js'
import { AiSkillFileEntity } from '../../../database/entities/ai-skill-file-entity.js'
import { hashContent } from '../core/skills/skill.draft.js'
import { SKILL_FILE } from '../core/skills/skill.paths.js'

/**
 * 技能库的数据访问层（设计 `docs/design/ai-skill-library.md` §2.1）。
 *
 * 只做读写与映射，不含业务判断（校验、落盘、导入编排在 service）。
 * 几条与表结构绑定的口径：
 * - `ai_skills` 软删、`ai_skill_files` 硬删（文件没有独立审计价值，软删还会撞唯一键）；
 * - 版本号是**条件更新**（`where version = ?`）推进的：两个人同时保存时，后一个拿到 0 行更新，
 *   由 service 翻译成 3417；
 * - 事务里的操作都接 `manager`，仓储不自己开事务（编排在 service）。
 */
@Injectable()
export class SkillRepository {
  constructor(@Inject(Db) private readonly db: Db) {}

  private async repo(manager?: EntityManager) {
    return (manager ?? this.db.dataSource.manager).getRepository(AiSkillEntity)
  }

  private async fileRepo(manager?: EntityManager) {
    return (manager ?? this.db.dataSource.manager).getRepository(AiSkillFileEntity)
  }

  /** 按名字取（软删自动排除） */
  async find(skillKey: string): Promise<AiSkillEntity | null> {
    return (await this.repo()).findOneBy({ skillKey })
  }

  /** 分页列表（后台页用；按更新时间倒序，方便"刚改过的在上面"） */
  async page(query: AiSkillListDto): Promise<PageQueryResult<AiSkillEntity>> {
    const builder = (await this.repo())
      .createQueryBuilder('s')
      .orderBy('s.updated_at', 'DESC')
      .addOrderBy('s.id', 'DESC')
    if (query.keyword) {
      builder.andWhere('(s.skill_key ILIKE :keyword OR s.title ILIKE :keyword)', {
        keyword: `%${query.keyword}%`,
      })
    }
    if (query.enabled !== undefined) builder.andWhere('s.enabled = :enabled', { enabled: query.enabled })
    if (query.source !== undefined) builder.andWhere('s.source = :source', { source: query.source })
    const { data, total } = await pageWith(builder, query.page, query.size)
    return { items: data, total, page: query.page, size: query.size }
  }

  /** 一个技能的全部文件（按路径排序，SKILL.md 在最前） */
  async filesOf(skillId: string, manager?: EntityManager): Promise<AiSkillFileEntity[]> {
    const files = await (await this.fileRepo(manager)).find({ where: { skillId } })
    return files.sort((a, b) => {
      if (a.path === SKILL_FILE) return -1
      if (b.path === SKILL_FILE) return 1
      return a.path.localeCompare(b.path)
    })
  }

  /** 单个文件 */
  async fileOf(skillId: string, path: string): Promise<AiSkillFileEntity | null> {
    return (await this.fileRepo()).findOneBy({ skillId, path })
  }

  /** 全部技能（启动同步用；`enabledOnly` 时只取启用的） */
  async listAll(enabledOnly: boolean): Promise<AiSkillEntity[]> {
    const repo = await this.repo()
    return repo.find({
      ...(enabledOnly ? { where: { enabled: true } } : {}),
      order: { createdAt: 'ASC' },
    })
  }

  /** 批量取文件（启动同步用：一次查完，别 N+1） */
  async filesOfMany(skillIds: readonly string[]): Promise<AiSkillFileEntity[]> {
    if (skillIds.length === 0) return []
    return (await this.fileRepo()).find({ where: { skillId: In([...skillIds]) } })
  }

  /**
   * 新建技能（技能行 + 全部文件，同一事务）。
   *
   * `version` 从 1 开始；`SKILL.md` 必须已经在 `files` 里（service 负责拼）。
   */
  async create(
    skill: Partial<AiSkillEntity> & { skillKey: string; description: string },
    files: readonly { path: string; content: string }[],
  ): Promise<AiSkillEntity> {
    return this.db.dataSource.transaction(async (manager) => {
      const repo = await this.repo(manager)
      const entity = await repo.save(
        repo.create({
          ...skill,
          version: 1,
          fileCount: files.length,
          warnings: skill.warnings ?? [],
        }),
      )
      await this.writeFiles(manager, entity.id, files)
      return entity
    })
  }

  /**
   * 条件推进版本号（乐观锁）：`version = expected` 时才 +1。
   *
   * @returns 新版本号；返回 `null` = 行已被别人改过（service 抛 3417）
   */
  async bumpVersion(
    id: string,
    expectedVersion: number | undefined,
    manager?: EntityManager,
  ): Promise<number | null> {
    const repo = await this.repo(manager)
    if (expectedVersion === undefined) {
      await repo.increment({ id }, 'version', 1)
      const current = await repo.findOneByOrFail({ id })
      return current.version
    }
    const result = await repo
      .createQueryBuilder()
      .update(AiSkillEntity)
      .set({ version: () => 'version + 1' })
      .where('id = :id AND version = :version', { id, version: expectedVersion })
      .execute()
    if (!result.affected) return null
    const current = await repo.findOneByOrFail({ id })
    return current.version
  }

  /** 更新技能行（不碰版本号；版本号由 `bumpVersion` 单独推进） */
  async update(id: string, patch: Partial<AiSkillEntity>, manager?: EntityManager): Promise<void> {
    await (await this.repo(manager)).update({ id }, patch as never)
  }

  /** 写一个文件（存在则覆盖，不存在则插入） */
  async saveFile(
    manager: EntityManager,
    skillId: string,
    file: { path: string; content: string },
  ): Promise<void> {
    const repo = await this.fileRepo(manager)
    const existing = await repo.findOneBy({ skillId, path: file.path })
    const size = Buffer.byteLength(file.content, 'utf8')
    const sha256 = hashContent(file.content)
    if (existing) {
      await repo.update({ id: existing.id }, { content: file.content, size, sha256 })
      return
    }
    await repo.save(repo.create({ skillId, path: file.path, content: file.content, size, sha256 }))
  }

  /** 批量覆盖文件（新建技能时用） */
  async writeFiles(
    manager: EntityManager,
    skillId: string,
    files: readonly { path: string; content: string }[],
  ): Promise<void> {
    for (const file of files) {
      await this.saveFile(manager, skillId, file)
    }
  }

  /** 删一个文件（硬删） */
  async removeFile(manager: EntityManager, skillId: string, path: string): Promise<void> {
    await (await this.fileRepo(manager)).delete({ skillId, path })
  }

  /** 软删技能 + 硬删文件 */
  async softRemove(id: string): Promise<void> {
    await this.db.dataSource.transaction(async (manager) => {
      await (await this.fileRepo(manager)).delete({ skillId: id })
      await (await this.repo(manager)).softDelete({ id })
    })
  }

  /** 整体替换一个技能的文件集合（导入覆盖时用：先清空再写入） */
  async replaceFiles(
    manager: EntityManager,
    skillId: string,
    files: readonly { path: string; content: string }[],
  ): Promise<void> {
    await (await this.fileRepo(manager)).delete({ skillId })
    await this.writeFiles(manager, skillId, files)
  }

  /** 开一个事务（编排在 service，仓储只提供入口） */
  async transaction<T>(task: (manager: EntityManager) => Promise<T>): Promise<T> {
    return this.db.dataSource.transaction(task)
  }
}
