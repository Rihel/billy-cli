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

  /**
   * 列出所有 container 后端的工作区 id（只取 id）。
   *
   * 回收器用它做「孤儿认领」：进程重启后内存里的 handle 没了，但容器还在跑，
   * 得从 DB 反查出候选集，再逐个探测容器是否真的在跑。
   */
  async listContainerWorkspaceIds(): Promise<string[]> {
    const rows = await this.db
      .getRepository(AiWorkspaceEntity)
      .find({ where: { backend: 'container' }, select: { id: true } })
    return rows.map((row) => row.id)
  }
}
