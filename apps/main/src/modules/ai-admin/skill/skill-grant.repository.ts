import { Inject, Injectable } from '@nestjs/common'
import { Db } from '@repo/kits'
import { AiSkillGrantEntity } from '@repo/db'
import { nanoid, type SkillGrantPrincipal } from '@repo/shared'

/** 技能授权仓储：按 skillKey 覆盖式设置（平台技能的可见主体集合） */
@Injectable()
export class SkillGrantRepository {
  constructor(@Inject(Db) private readonly db: Db) {}

  private repo() {
    return this.db.getRepository(AiSkillGrantEntity)
  }

  async list(skillKey: string): Promise<AiSkillGrantEntity[]> {
    return this.repo().find({ where: { skillKey }, order: { createdAt: 'ASC' } })
  }

  /** 覆盖式替换：保留交集、软删多余、插入新增（幂等） */
  async replace(
    skillKey: string,
    principals: SkillGrantPrincipal[],
    grantedBy: string | null,
  ): Promise<AiSkillGrantEntity[]> {
    const repo = this.repo()
    const existing = await repo.find({ where: { skillKey } })
    const keyOf = (item: { principalType: string; principalId: string }) =>
      `${item.principalType}:${item.principalId}`
    const wanted = new Set(principals.map(keyOf))

    const stale = existing.filter((item) => !wanted.has(keyOf(item)))
    if (stale.length > 0) await repo.softDelete(stale.map((item) => item.id))

    const have = new Set(existing.map(keyOf))
    const missing = principals.filter((item) => !have.has(keyOf(item)))
    if (missing.length > 0) {
      await repo.insert(
        missing.map((item) => ({
          skillKey,
          principalType: item.principalType,
          principalId: item.principalId,
          grantedBy,
          // insert 不触发 @BeforeInsert（主键由它生成），必须显式给 id
          id: nanoid(),
        })),
      )
    }
    return this.list(skillKey)
  }
}
