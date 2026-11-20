import { Inject, Injectable } from '@nestjs/common'
import { AppLogger, Db } from '@repo/kits'
import { AiWorkspaceEntity } from '@repo/db'
import type { SkillGrantPrincipal } from '@repo/shared'

/** 技能集合同步端口（main → workspace-service；测试可替换） */
export interface SkillSyncPort {
  status(workspaceId: string): Promise<{ state: string }>
  sync(workspaceId: string): Promise<unknown>
}

export const SKILL_SYNC_PORT = Symbol('SKILL_SYNC_PORT')

/**
 * **技能集合变更传播**（`docs/design/workspace-cli-credentials.md` §6.7.4）。
 *
 * 授权授予 / 收回后，把受影响主体的运行中工作区收敛一次（写可见技能、删不可见目录）。
 * 与凭据同步同一套口径：**只查不起**、失败交给 `ensure` 兜底。
 * 撤销授权尤其重要：不删目录，模型仍能通过 `file-read` 读到正文。
 */
@Injectable()
export class SkillSyncService {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(SKILL_SYNC_PORT) private readonly port: SkillSyncPort,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}

  async push(principals: SkillGrantPrincipal[]): Promise<{ pushed: number; failed: number }> {
    // `all`（全员开放）的授予 / 收回影响所有人：推全部工作区（仍只推运行中的）
    const broadcast = principals.some((item) => item.principalType === 'all')
    const owners = principals.filter((item) => item.principalType !== 'all')
    if (!broadcast && owners.length === 0) return { pushed: 0, failed: 0 }

    const workspaces = await this.db.getRepository(AiWorkspaceEntity).find({
      ...(broadcast
        ? {}
        : {
            where: owners.map((item) => ({
              ownerType: item.principalType as 'user' | 'admin',
              ownerId: item.principalId,
            })),
          }),
      select: { id: true },
    })

    let pushed = 0
    let failed = 0
    for (const workspace of workspaces) {
      try {
        const status = await this.port.status(workspace.id)
        if (status.state !== 'running') continue
        await this.port.sync(workspace.id)
        pushed += 1
      } catch (error) {
        failed += 1
        this.logger.warn('skill.sync_failed', {
          workspaceId: workspace.id,
          reason: error instanceof Error ? error.message : String(error),
        })
      }
    }
    if (pushed > 0 || failed > 0) {
      this.logger.log('skill.sync', { owners: owners.length, pushed, failed })
    }
    return { pushed, failed }
  }
}
