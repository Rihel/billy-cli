import { Inject, Injectable } from '@nestjs/common'
import { Db } from '@repo/kits'
import { AiConnectorEntity } from '../../../database/entities/ai-connector-entity.js'

/** 驱动自己解释的授权状态快照（当前只有 lark-cli 用） */
export interface ConnectorAuthState {
  /** 读出来时的版本号；写回时作为 CAS 的期望值 */
  version: number
  /** 相对路径 → 文件内容（base64）。路径与结构由驱动自己解释 */
  files: Record<string, string>
}

/**
 * **连接器的授权状态存储**（`ai_connectors.auth_state`）。
 *
 * 为什么需要：pod 是无状态的、不挂 PVC。CLI 的用户 token 在磁盘上，
 * 进程一换就丢；驱动每次调用前 hydrate、调用后 diff 写回。
 *
 * 写回用**版本号 CAS**：两个实例同时写时，后写的会失败（返回 null），
 * 由调用方决定重试或放弃，不会静默覆盖别人的授权。
 */
@Injectable()
export class ConnectorStateStore {
  constructor(@Inject(Db) private readonly db: Db) {}

  /** 读状态；没配过 / 没授权时返回 null */
  async load(connectorId: string): Promise<ConnectorAuthState | null> {
    const repo = this.db.getRepository(AiConnectorEntity)
    const row = await repo.findOne({
      where: { id: connectorId },
      select: { id: true, authState: true, authStateVersion: true },
    })
    if (!row?.authState) return null
    return { version: row.authStateVersion, files: row.authState as Record<string, string> }
  }

  /**
   * 写回状态（CAS）。
   *
   * @returns 写入后的新版本号；`null` = 版本已被别的实例改过，本次没写
   */
  async save(
    connectorId: string,
    files: Record<string, string>,
    expectedVersion: number,
  ): Promise<number | null> {
    const repo = this.db.getRepository(AiConnectorEntity)
    const result = await repo
      .createQueryBuilder()
      .update()
      .set({
        authState: files,
        // 用 SQL 表达式自增，避免读改写丢更新
        authStateVersion: () => 'auth_state_version + 1',
      })
      .where('id = :id AND auth_state_version = :version', {
        id: connectorId,
        version: expectedVersion,
      })
      .execute()
    return result.affected ? expectedVersion + 1 : null
  }

  /** 删除连接器时清掉授权状态（token 不在库里留） */
  async clear(connectorId: string): Promise<void> {
    const repo = this.db.getRepository(AiConnectorEntity)
    await repo
      .createQueryBuilder()
      .update()
      .set({
        authState: null,
        authStateVersion: () => 'auth_state_version + 1',
      })
      .where('id = :id', { id: connectorId })
      .execute()
  }
}
