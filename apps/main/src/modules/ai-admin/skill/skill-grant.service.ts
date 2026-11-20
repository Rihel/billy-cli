import { Inject, Injectable } from '@nestjs/common'
import { AppLogger, Transactional } from '@repo/kits'
import type { SkillGrantListDto, SkillGrantModel, SkillGrantSetDto } from '@repo/shared'
import { currentAdminId } from '../../../common/security/index.js'
import { SkillGrantRepository } from './skill-grant.repository.js'
import { SkillSyncService } from './skill-sync.service.js'

/** 技能授权管理（§6.7.2）：平台技能默认不可见，管理员在这里授予 / 收回 */
@Injectable()
export class SkillGrantService {
  constructor(
    @Inject(SkillGrantRepository) private readonly grants: SkillGrantRepository,
    @Inject(SkillSyncService) private readonly sync: SkillSyncService,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}

  async list(input: SkillGrantListDto): Promise<SkillGrantModel[]> {
    const rows = await this.grants.list(input.skillKey)
    return rows.map((row) => ({
      id: row.id,
      skillKey: row.skillKey,
      principalType: row.principalType as SkillGrantModel['principalType'],
      principalId: row.principalId,
      grantedBy: row.grantedBy,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }))
  }

  /** 覆盖式设置：传进来的就是最终集合（空数组 = 收回全部授权） */
  @Transactional()
  async set(input: SkillGrantSetDto): Promise<SkillGrantModel[]> {
    // 受影响主体 = 变更前后并集（被收回的人也要推送，否则目录删不掉）
    const before = (await this.grants.list(input.skillKey)).map((row) => ({
      principalType: row.principalType as SkillGrantModel['principalType'],
      principalId: row.principalId,
    }))
    await this.grants.replace(input.skillKey, input.principals, currentAdminId())
    this.logger.log('skill.grants_set', {
      skillKey: input.skillKey,
      principals: input.principals.length,
    })
    // 推送收敛（尽力而为；失败由下次 ensure 兜底）
    const affected = [...before, ...input.principals].filter(
      (item, index, list) =>
        list.findIndex(
          (other) =>
            other.principalType === item.principalType && other.principalId === item.principalId,
        ) === index,
    )
    void this.sync.push(affected).catch((error: unknown) =>
      this.logger.warn('skill.sync_push_failed', {
        reason: error instanceof Error ? error.message : String(error),
      }),
    )
    return this.list({ skillKey: input.skillKey })
  }
}
