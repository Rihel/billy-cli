import { Inject, Injectable } from '@nestjs/common'
import { Db } from '@repo/kits'
import { AiWorkspaceEntity } from '@repo/db'
import type { WorkspaceConfig } from '@repo/contracts'

/**
 * `ai_workspaces` 的**只读**访问。
 *
 * 写方是 main（配置 / desired_status / 软删）；执行面只读配置去起容器，
 * 运行态不写回（见 `docs/design/workspace.md` §7）。
 */
@Injectable()
export class WorkspaceRepository {
  constructor(@Inject(Db) private readonly db: Db) {}

  async findConfig(workspaceId: string): Promise<WorkspaceConfig | null> {
    const row = await this.db
      .getRepository(AiWorkspaceEntity)
      .findOne({ where: { id: workspaceId } })
    if (!row) return null
    return {
      id: row.id,
      name: row.name,
      backend: row.backend as WorkspaceConfig['backend'],
      image: row.image ?? undefined,
      location: (row.location ?? undefined) as WorkspaceConfig['location'],
      fileAccess: row.fileAccess as WorkspaceConfig['fileAccess'],
    }
  }
}
