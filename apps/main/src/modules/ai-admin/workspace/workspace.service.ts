import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common'
import { AppLogger, Db } from '@repo/kits'
import { AiWorkspaceEntity } from '@repo/db'
import { WorkspaceServiceClient } from '@repo/internal-sdk'
import type { WorkspaceBackend, WorkspaceFileAccess } from '@repo/contracts'

export interface WorkspaceModel {
  id: string
  name: string
  isDefault: boolean
  backend: WorkspaceBackend
  image: string | null
  fileAccess: WorkspaceFileAccess
  desiredStatus: 'running' | 'stopped'
  /** 实时运行态（不落库） */
  runtime: { state: 'running' | 'stopped' | 'unknown'; containerId?: string; startedAt?: number }
  createdAt: Date
  updatedAt: Date
}

export interface WorkspaceCreateInput {
  name?: string
  backend?: WorkspaceBackend
  image?: string
  fileAccess?: WorkspaceFileAccess
}

export interface WorkspaceUpdateInput {
  name?: string
  image?: string | null
  fileAccess?: WorkspaceFileAccess
}

const ownerOf = (ownerId: string): { ownerType: string; ownerId: string } => ({
  ownerType: 'admin',
  ownerId,
})

/**
 * 工作区的**控制面**（方案 B）：main 是 `ai_workspaces` 的唯一写方。
 *
 * - CRUD / `desired_status` 写表；
 * - 启动 / 停止 / 销毁转发给 workspace-service；
 * - 列表时向执行面查一次实时运行态，**不把运行态写回表**。
 */
@Injectable()
export class WorkspaceAdminService {
  private readonly client = new WorkspaceServiceClient({
    baseUrl: process.env.WORKSPACE_SERVICE_URL?.trim() || 'http://127.0.0.1:9995',
    token:
      process.env.WORKSPACE_INTERNAL_TOKEN?.trim() ||
      process.env.TOOL_INTERNAL_TOKEN?.trim() ||
      'dev-workspace-token',
  })

  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}

  private repo() {
    return this.db.getRepository(AiWorkspaceEntity)
  }

  /** 确保主体有一条默认工作区（幂等；AdminService.create 与补偿任务共用） */
  async ensureDefault(ownerId: string): Promise<void> {
    const existing = await this.repo().findOne({
      where: { ...ownerOf(ownerId), isDefault: true },
    })
    if (existing) return
    await this.repo().insert({
      ...ownerOf(ownerId),
      name: '默认工作区',
      isDefault: true,
      backend: 'container',
      image: null,
      location: null,
      fileAccess: 'write',
      desiredStatus: 'stopped',
    })
    this.logger.log('workspace.default_created', { ownerId })
  }

  async list(ownerId: string): Promise<WorkspaceModel[]> {
    const rows = await this.repo().find({
      where: ownerOf(ownerId),
      order: { isDefault: 'DESC', createdAt: 'ASC' },
    })
    return Promise.all(rows.map((row) => this.toModel(row)))
  }

  async create(ownerId: string, input: WorkspaceCreateInput): Promise<WorkspaceModel> {
    await this.ensureDefault(ownerId)
    const entity = await this.repo().save({
      ...ownerOf(ownerId),
      name: input.name?.trim() || '未命名工作区',
      isDefault: false,
      backend: input.backend ?? 'container',
      image: input.image?.trim() || null,
      location: null,
      fileAccess: input.fileAccess ?? 'write',
      desiredStatus: 'stopped',
    })
    return this.toModel(entity)
  }

  async update(ownerId: string, id: string, input: WorkspaceUpdateInput): Promise<WorkspaceModel> {
    const row = await this.requireOwned(ownerId, id)
    await this.repo().update(
      { id: row.id },
      {
        ...(input.name === undefined ? {} : { name: input.name.trim() || row.name }),
        ...(input.image === undefined ? {} : { image: input.image?.trim() || null }),
        ...(input.fileAccess === undefined ? {} : { fileAccess: input.fileAccess }),
      },
    )
    return this.toModel(await this.requireOwned(ownerId, id))
  }

  async remove(ownerId: string, id: string): Promise<{ removed: boolean }> {
    const row = await this.requireOwned(ownerId, id)
    if (row.isDefault) throw new NotFoundException('默认工作区不能删除')
    await this.client.destroy(row.id).catch((error: unknown) => {
      this.logger.warn('workspace.destroy_failed', {
        workspaceId: row.id,
        reason: error instanceof Error ? error.message : String(error),
      })
    })
    await this.repo().softDelete({ id: row.id })
    return { removed: true }
  }

  async start(ownerId: string, id: string): Promise<WorkspaceModel> {
    const row = await this.requireOwned(ownerId, id)
    try {
      await this.client.ensure(row.id)
      await this.repo().update({ id: row.id }, { desiredStatus: 'running', lastUsedAt: new Date() })
      return await this.toModel(await this.requireOwned(ownerId, id))
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      this.logger.error('workspace.start_failed', { workspaceId: row.id, reason })
      throw new BadRequestException(`启动工作区失败：${reason}`)
    }
  }

  async stop(ownerId: string, id: string): Promise<WorkspaceModel> {
    const row = await this.requireOwned(ownerId, id)
    await this.client.stop(row.id)
    await this.repo().update({ id: row.id }, { desiredStatus: 'stopped' })
    return this.toModel(await this.requireOwned(ownerId, id))
  }

  private async requireOwned(ownerId: string, id: string): Promise<AiWorkspaceEntity> {
    const row = await this.repo().findOne({ where: { id, ...ownerOf(ownerId) } })
    if (!row) throw new NotFoundException('工作区不存在')
    return row
  }

  private async toModel(row: AiWorkspaceEntity): Promise<WorkspaceModel> {
    const runtime = await this.client
      .status(row.id)
      .then((status) => ({
        state: status.state,
        ...(status.containerId ? { containerId: status.containerId } : {}),
        ...(status.startedAt === undefined ? {} : { startedAt: status.startedAt }),
      }))
      .catch(() => ({ state: 'unknown' as const }))
    return {
      id: row.id,
      name: row.name,
      isDefault: row.isDefault,
      backend: row.backend as WorkspaceBackend,
      image: row.image,
      fileAccess: row.fileAccess as WorkspaceFileAccess,
      desiredStatus: row.desiredStatus as 'running' | 'stopped',
      runtime,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }
  }
}
