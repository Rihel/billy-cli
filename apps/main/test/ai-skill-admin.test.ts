import { describe, expect, it } from 'vitest'
import { AppErrorCodes } from '@repo/shared'
import type { EntityManager } from 'typeorm'
import type { AiSkillEntity, AiSkillFileEntity } from '@repo/db'
import type { AppLogger } from '@repo/kits'
import { SkillAdminService } from '../src/modules/ai-admin/skill/skill.service.js'
import type { SkillRepository } from '../src/modules/ai-admin/skill/skill.repository.js'
import type {
  SkillChangeEvent,
  SkillChangeNotifier,
} from '../src/modules/ai-admin/skill/skill.ports.js'
import { SKILL_FILE } from '../src/modules/ai-admin/skill/skill.rules.js'

/**
 * main 技能管理模块的最小单测：**创建 / 更新**两条主链路。
 *
 * 用 fake repository 而不是真库：这里要钉的是 service 的编排（校验、乐观锁、SKILL.md 拼装、
 * 变更通知），不是 TypeORM。真实 SQL 由既有的实体与 repository 实现保证。
 */

const logger = {
  log: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
} as unknown as AppLogger

class FakeNotifier implements SkillChangeNotifier {
  readonly events: SkillChangeEvent[] = []
  async notify(event: SkillChangeEvent): Promise<boolean> {
    this.events.push(event)
    return true
  }
}

class FakeSkillRepository {
  private readonly skills = new Map<string, AiSkillEntity>()
  private readonly files = new Map<string, AiSkillFileEntity[]>()
  private sequence = 0

  async find(skillKey: string): Promise<AiSkillEntity | null> {
    return this.skills.get(skillKey) ?? null
  }

  async filesOf(skillId: string): Promise<AiSkillFileEntity[]> {
    return [...(this.files.get(skillId) ?? [])].sort((left, right) => {
      if (left.path === SKILL_FILE) return -1
      if (right.path === SKILL_FILE) return 1
      return left.path.localeCompare(right.path)
    })
  }

  async fileOf(skillId: string, path: string): Promise<AiSkillFileEntity | null> {
    return (this.files.get(skillId) ?? []).find((file) => file.path === path) ?? null
  }

  async create(
    skill: Partial<AiSkillEntity> & { skillKey: string; description: string },
    files: readonly { path: string; content: string }[],
  ): Promise<AiSkillEntity> {
    const id = `skill-${++this.sequence}`
    const entity = {
      id,
      skillKey: skill.skillKey,
      title: skill.title ?? '',
      description: skill.description,
      frontmatter: skill.frontmatter ?? {},
      enabled: skill.enabled ?? true,
      source: skill.source ?? 'online',
      originUrl: skill.originUrl ?? null,
      version: 1,
      fileCount: files.length,
      contentHash: null,
      lastMaterializedAt: null,
      lastValidatedAt: skill.lastValidatedAt ?? null,
      warnings: skill.warnings ?? [],
      updatedBy: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as unknown as AiSkillEntity
    this.skills.set(entity.skillKey, entity)
    this.files.set(
      id,
      files.map((file) => this.makeFile(id, file.path, file.content)),
    )
    return entity
  }

  async bumpVersion(id: string, expectedVersion: number | undefined): Promise<number | null> {
    const entity = this.findById(id)
    if (expectedVersion !== undefined && entity.version !== expectedVersion) return null
    entity.version += 1
    return entity.version
  }

  async update(id: string, patch: Partial<AiSkillEntity>): Promise<void> {
    const entity = this.findById(id)
    Object.assign(entity, patch, { updatedAt: new Date() })
  }

  async saveFile(
    _manager: EntityManager,
    skillId: string,
    file: { path: string; content: string },
  ): Promise<void> {
    const list = this.files.get(skillId) ?? []
    const index = list.findIndex((item) => item.path === file.path)
    const next = this.makeFile(skillId, file.path, file.content)
    if (index >= 0) list[index] = next
    else list.push(next)
    this.files.set(skillId, list)
  }

  async removeFile(_manager: EntityManager, skillId: string, path: string): Promise<void> {
    this.files.set(
      skillId,
      (this.files.get(skillId) ?? []).filter((file) => file.path !== path),
    )
  }

  async replaceFiles(
    _manager: EntityManager,
    skillId: string,
    files: readonly { path: string; content: string }[],
  ): Promise<void> {
    this.files.set(
      skillId,
      files.map((file) => this.makeFile(skillId, file.path, file.content)),
    )
  }

  async softRemove(id: string): Promise<void> {
    const entity = this.findById(id)
    this.skills.delete(entity.skillKey)
    this.files.delete(id)
  }

  async transaction<T>(task: (manager: EntityManager) => Promise<T>): Promise<T> {
    return task({} as EntityManager)
  }

  /** 直接读库内实体（断言用） */
  peek(skillKey: string): AiSkillEntity {
    const entity = this.skills.get(skillKey)
    if (!entity) throw new Error(`测试数据不存在：${skillKey}`)
    return entity
  }

  private findById(id: string): AiSkillEntity {
    const entity = [...this.skills.values()].find((item) => item.id === id)
    if (!entity) throw new Error(`测试数据不存在：${id}`)
    return entity
  }

  private makeFile(skillId: string, path: string, content: string): AiSkillFileEntity {
    return {
      id: `${skillId}:${path}`,
      skillId,
      path,
      content,
      size: Buffer.byteLength(content, 'utf8'),
      sha256: '',
      createdAt: new Date(),
      updatedAt: new Date(),
    } as unknown as AiSkillFileEntity
  }
}

const setup = () => {
  const repository = new FakeSkillRepository()
  const notifier = new FakeNotifier()
  const service = new SkillAdminService(repository as unknown as SkillRepository, notifier, logger)
  return { repository, notifier, service }
}

const createDemo = (service: SkillAdminService) =>
  service.create({
    skillKey: 'demo-skill',
    title: '演示技能',
    description: '什么时候用这个演示技能',
    body: '# 演示\n\n正文',
    frontmatter: { license: 'MIT' },
    enabled: true,
  })

describe('技能创建', () => {
  it('拼出 SKILL.md、写库并发送 upsert 通知', async () => {
    const { repository, notifier, service } = setup()

    const detail = await createDemo(service)

    expect(detail.skillKey).toBe('demo-skill')
    expect(detail.title).toBe('演示技能')
    expect(detail.version).toBe(1)
    expect(detail.frontmatter).toEqual({ license: 'MIT' })
    expect(detail.files.map((file) => file.path)).toEqual([SKILL_FILE])

    const entry = await repository.fileOf(detail.id, SKILL_FILE)
    expect(entry?.content).toContain('name: demo-skill')
    expect(entry?.content).toContain('description: 什么时候用这个演示技能')
    expect(entry?.content).toContain('license: MIT')
    expect(entry?.content).toContain('# 演示')

    expect(notifier.events).toHaveLength(1)
    expect(notifier.events[0]).toMatchObject({
      skillKey: 'demo-skill',
      action: 'upsert',
      version: 1,
      enabled: true,
      reason: 'create',
    })
  })

  it('重名直接拒绝（3414）', async () => {
    const { service } = setup()
    await createDemo(service)
    await expect(createDemo(service)).rejects.toMatchObject({
      code: AppErrorCodes.SkillKeyConflict,
    })
  })

  it('description 超长被纯函数校验拦下（3413），不写库', async () => {
    const { repository, service } = setup()
    await expect(
      service.create({
        skillKey: 'too-long',
        description: 'x'.repeat(1100),
        body: '',
        enabled: true,
      }),
    ).rejects.toMatchObject({ code: AppErrorCodes.SkillInvalid })
    expect(await repository.find('too-long')).toBeNull()
  })
})

describe('技能更新', () => {
  it('改 description 会重建 SKILL.md、推进版本并通知（保留原正文）', async () => {
    const { repository, notifier, service } = setup()
    const created = await createDemo(service)

    const updated = await service.update({
      skillKey: 'demo-skill',
      description: '新的使用说明',
      expectedVersion: created.version,
    })

    expect(updated.version).toBe(2)
    expect(updated.description).toBe('新的使用说明')
    const entry = await repository.fileOf(created.id, SKILL_FILE)
    expect(entry?.content).toContain('description: 新的使用说明')
    // 正文是从原 SKILL.md 解析出来的，不能被元信息更新冲掉
    expect(entry?.content).toContain('# 演示')
    expect(notifier.events.at(-1)).toMatchObject({
      skillKey: 'demo-skill',
      action: 'upsert',
      version: 2,
      reason: 'update',
    })
  })

  it('expectedVersion 过期抛乐观锁冲突（3417），内容不变', async () => {
    const { repository, notifier, service } = setup()
    const created = await createDemo(service)
    const before = await repository.fileOf(created.id, SKILL_FILE)

    await expect(
      service.update({
        skillKey: 'demo-skill',
        description: '另一个人的修改',
        expectedVersion: 999,
      }),
    ).rejects.toMatchObject({ code: AppErrorCodes.SkillVersionConflict })

    expect(repository.peek('demo-skill').description).toBe('什么时候用这个演示技能')
    expect((await repository.fileOf(created.id, SKILL_FILE))?.content).toBe(before?.content)
    // 冲突发生在事务里，写后收尾不会执行 → 不应该发出新的通知
    expect(notifier.events).toHaveLength(1)
  })

  it('只改开关不推进版本；停用发 remove、重新启用发 upsert', async () => {
    const { repository, notifier, service } = setup()
    const created = await createDemo(service)

    const disabled = await service.update({ skillKey: 'demo-skill', enabled: false })
    expect(disabled.version).toBe(created.version)
    expect(repository.peek('demo-skill').enabled).toBe(false)
    expect(notifier.events.at(-1)).toMatchObject({
      skillKey: 'demo-skill',
      action: 'remove',
      version: created.version,
      enabled: false,
    })

    const enabled = await service.update({ skillKey: 'demo-skill', enabled: true })
    expect(enabled.version).toBe(created.version)
    expect(notifier.events.at(-1)).toMatchObject({
      skillKey: 'demo-skill',
      action: 'upsert',
      enabled: true,
    })
  })
})

describe('文件 CRUD 与路径校验', () => {
  it('写文件推进版本；读回内容；删文件再推进版本', async () => {
    const { service } = setup()
    const created = await createDemo(service)

    const afterSave = await service.saveFile({
      skillKey: 'demo-skill',
      path: 'references/check-list.md',
      content: '检查项',
      expectedVersion: created.version,
    })
    expect(afterSave.version).toBe(2)

    const content = await service.readFile('demo-skill', 'references/check-list.md')
    expect(content.content).toBe('检查项')
    expect(content.kind).toBe('markdown')

    const afterRemove = await service.removeFile({
      skillKey: 'demo-skill',
      path: 'references/check-list.md',
      expectedVersion: afterSave.version,
    })
    expect(afterRemove.version).toBe(3)
    expect(afterRemove.files.map((file) => file.path)).toEqual([SKILL_FILE])
  })

  it('拒绝白名单外路径；SKILL.md 不能删（3415）', async () => {
    const { service } = setup()
    await createDemo(service)

    await expect(
      service.saveFile({
        skillKey: 'demo-skill',
        path: '../escape.md',
        content: 'x',
      }),
    ).rejects.toMatchObject({ code: AppErrorCodes.SkillFileInvalid })

    await expect(
      service.removeFile({ skillKey: 'demo-skill', path: SKILL_FILE }),
    ).rejects.toMatchObject({ code: AppErrorCodes.SkillFileInvalid })
  })
})
