import { Inject, Injectable } from '@nestjs/common'
import { AiSkillEntity } from '@repo/db'
import { Db } from '@repo/kits'

/**
 * 技能清单查询（只给 `/agent/list` 展开 `skills: ['*']` 用）。
 *
 * 只读启用中的 `skill_key`；技能正文与落盘不在这里（那是技能库管理模块的职责）。
 */
@Injectable()
export class AiSkillQueryRepository {
  constructor(@Inject(Db) private readonly db: Db) {}

  /** 当前启用的技能名（按名字升序，保证清单稳定） */
  async enabledNames(): Promise<string[]> {
    const repo = this.db.getRepository(AiSkillEntity)
    const rows = await repo.find({
      where: { enabled: true },
      select: { skillKey: true },
      order: { skillKey: 'ASC' },
    })
    return rows.map((row) => row.skillKey)
  }
}
