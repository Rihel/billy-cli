import { Inject, Injectable } from '@nestjs/common'
import { AiConnectorEntity, AiToolEntity } from '@repo/db'
import { Db, type PageQueryResult } from '@repo/kits'
import type { AiConnectorListDto } from '@repo/shared'
import { Like } from 'typeorm'

/**
 * 连接器的数据访问层（设计 `docs/design/ai-connector.md` §3.2 / §3.6）。
 *
 * **唯一事实源是 `@repo/db` 的实体**：main 与 agent-runtime 各自读同一张
 * `ai_connectors` / `ai_tools`，没有谁"同步"给谁的问题。
 *
 * 写入口径（控制面只做 CRUD + 状态落库）：
 * - 实例的增删改查在这里；
 * - `ai_tools` 只**读**（详情页展示）与**停用**（删除实例时立刻失去可调性）；
 * - **工具行的新增 / 更新（能力发现的结果）由 agent-runtime 的 `ConnectorSyncService` 写**，
 *   main 不连接远端发现能力，也不注册工具（边界见 `connector.service.ts`）。
 */
export interface ConnectorStore {
  findById(id: string): Promise<AiConnectorEntity | null>
  findByKey(key: string): Promise<AiConnectorEntity | null>
  list(query: AiConnectorListDto): Promise<PageQueryResult<AiConnectorEntity>>
  create(data: Partial<AiConnectorEntity>): Promise<AiConnectorEntity>
  update(id: string, patch: Partial<AiConnectorEntity>): Promise<void>
  /** 软删实例（唯一 key 带 `deleted_at IS NULL` 条件，删掉后可复用） */
  remove(id: string): Promise<void>
  /** 该实例产出的工具行（含已停用的：历史对话还引用着） */
  listTools(connectorId: string): Promise<AiToolEntity[]>
  /** 实例被删除时，把它产出的工具全部停用 */
  disableAllTools(connectorId: string): Promise<void>
}

/**
 * 仓储的 DI token。
 *
 * service 只依赖 {@link ConnectorStore} 接口：单测可以直接传内存实现，
 * 不必为了跑一条 CRUD 起数据库。
 */
export const CONNECTOR_STORE = Symbol.for('MainConnectorStore')

@Injectable()
export class ConnectorRepository implements ConnectorStore {
  constructor(@Inject(Db) private readonly db: Db) {}

  private connectorRepo() {
    return this.db.getRepository(AiConnectorEntity)
  }

  private toolRepo() {
    return this.db.getRepository(AiToolEntity)
  }

  async findById(id: string): Promise<AiConnectorEntity | null> {
    return this.connectorRepo().findOneBy({ id })
  }

  async findByKey(key: string): Promise<AiConnectorEntity | null> {
    return this.connectorRepo().findOneBy({ key })
  }

  async list(query: AiConnectorListDto): Promise<PageQueryResult<AiConnectorEntity>> {
    const repo = this.connectorRepo()
    const page = query.page ?? 1
    const size = query.size ?? 10
    const where: Record<string, unknown> = {}
    if (query.keyword) where.key = Like(`%${query.keyword.toLowerCase()}%`)
    if (query.enabled !== undefined) where.enabled = query.enabled

    const [items, total] = await repo.findAndCount({
      where,
      order: { createdAt: 'DESC' },
      skip: (page - 1) * size,
      take: size,
    })
    return { items, total, page, size }
  }

  async create(data: Partial<AiConnectorEntity>): Promise<AiConnectorEntity> {
    const repo = this.connectorRepo()
    return repo.save(repo.create(data))
  }

  async update(id: string, patch: Partial<AiConnectorEntity>): Promise<void> {
    await this.connectorRepo().update({ id }, patch as never)
  }

  async remove(id: string): Promise<void> {
    await this.connectorRepo().softDelete({ id })
  }

  async listTools(connectorId: string): Promise<AiToolEntity[]> {
    return this.toolRepo().find({
      where: { connectorId },
      order: { toolKey: 'ASC' },
    })
  }

  async disableAllTools(connectorId: string): Promise<void> {
    await this.toolRepo().update({ connectorId }, { enabled: false } as never)
  }
}
