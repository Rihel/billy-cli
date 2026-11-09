import { Inject, Injectable } from '@nestjs/common'
import { Db, type PageQueryResult } from '@repo/kits'
import type { AiConnectorListDto } from '@repo/shared'
import { In, IsNull, Like } from 'typeorm'
import { AiConnectorEntity } from '../../../database/entities/ai-connector-entity.js'
import { AiToolEntity } from '../../../database/entities/ai-tool-entity.js'

/**
 * 连接器的数据访问层（设计 `docs/design/ai-connector.md` §3.2 / §3.6）。
 *
 * 只做读写与映射，不含业务判断（合法性、探活、同步编排在 service）。
 * **工具行仍写 `ai_tools`**（`origin='connector'`），这里提供连接器视角的 upsert / 摘除。
 */

/** 同步一个工具时要写的字段（基础信息是能力描述的镜像） */
export interface ConnectorToolUpsert {
  toolKey: string
  remoteToolName: string
  title: string
  description: string
  paramSchema: Record<string, unknown> | null
}

@Injectable()
export class ConnectorRepository {
  constructor(@Inject(Db) private readonly db: Db) {}

  private async repo() {
    return this.db.getRepository(AiConnectorEntity)
  }

  private async toolRepo() {
    return this.db.getRepository(AiToolEntity)
  }

  async findById(id: string): Promise<AiConnectorEntity | null> {
    return (await this.repo()).findOneBy({ id })
  }

  async findByKey(key: string): Promise<AiConnectorEntity | null> {
    return (await this.repo()).findOneBy({ key })
  }

  async list(query: AiConnectorListDto): Promise<PageQueryResult<AiConnectorEntity>> {
    const repo = await this.repo()
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
    const repo = await this.repo()
    const entity = repo.create(data)
    return repo.save(entity)
  }

  async update(id: string, patch: Partial<AiConnectorEntity>): Promise<void> {
    await (await this.repo()).update({ id }, patch as never)
  }

  async remove(id: string): Promise<void> {
    await (await this.repo()).softDelete({ id })
  }

  /** 该连接器产出的全部工具行（含已停用的：历史对话还引用着） */
  async listTools(connectorId: string): Promise<AiToolEntity[]> {
    return (await this.toolRepo()).find({
      where: { connectorId },
      order: { toolKey: 'ASC' },
    })
  }

  /**
   * 写一条连接器工具。
   *
   * 口径（与种子同步刻意相反）：
   * - **只写基础信息**（title / description / param_schema / remote_tool_name）；
   * - 已存在时**不覆盖人工改过的 config / limits / enabled / scope**；
   * - 若同 key 是代码工具（origin='code'），直接报错——一个 key 只能有一个提供者。
   */
  async upsertTool(connectorId: string, input: ConnectorToolUpsert): Promise<void> {
    const repo = await this.toolRepo()
    const existing = await repo.findOneBy({ toolKey: input.toolKey })

    if (!existing) {
      await repo.save(
        repo.create({
          toolKey: input.toolKey,
          connectorId,
          origin: 'connector',
          remoteToolName: input.remoteToolName,
          title: input.title,
          description: input.description,
          paramSchema: input.paramSchema,
          enabled: true,
          source: 'seed',
        }),
      )
      return
    }

    if (existing.origin !== 'connector') {
      throw new Error(`工具 key 与代码工具冲突：${input.toolKey}`)
    }
    if (existing.connectorId !== connectorId) {
      throw new Error(`工具 key 已被另一条连接器占用：${input.toolKey}`)
    }

    await repo.update(
      { id: existing.id },
      {
        remoteToolName: input.remoteToolName,
        title: input.title,
        description: input.description,
        paramSchema: input.paramSchema,
        lastSeenAt: new Date(),
      } as never,
    )
  }

  /** 对方已经不再提供的工具：停用但保留行（历史对话可追溯） */
  async disableMissing(connectorId: string, keepKeys: readonly string[]): Promise<number> {
    const repo = await this.toolRepo()
    const where =
      keepKeys.length > 0
        ? { connectorId, toolKey: In(keepKeys) }
        : { connectorId: IsNull() }
    const keep = new Set(
      (await repo.find({ where })).map((row) => row.toolKey),
    )
    const all = await repo.find({ where: { connectorId } })
    const missing = all.filter((row) => !keep.has(row.toolKey))
    if (missing.length === 0) return 0
    await repo.update({ connectorId, toolKey: In(missing.map((row) => row.toolKey)) }, { enabled: false } as never)
    return missing.length
  }

  /** 连接器被删除 / 停用时，把它产出的工具全部停用 */
  async disableAll(connectorId: string): Promise<void> {
    await (await this.toolRepo()).update({ connectorId }, { enabled: false } as never)
  }
}
