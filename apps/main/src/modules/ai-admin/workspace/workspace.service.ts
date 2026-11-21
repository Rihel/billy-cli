import { BadRequestException, Inject, Injectable } from '@nestjs/common'
import { AppLogger, Db } from '@repo/kits'
import { AdminEntity, AiWorkspaceEntity, UserEntity } from '@repo/db'
import { WorkspaceServiceClient } from '@repo/internal-sdk'
import type { WorkspaceBackend, WorkspaceFileAccess } from '@repo/contracts'
import { scopeOf, type OwnerRef } from '../../../common/security/index.js'
import { DefaultWorkspaceUndeletableError, WorkspaceNotFoundError } from './workspace.errors.js'

export interface WorkspaceModel {
  id: string
  ownerType: 'user' | 'admin'
  ownerId: string
  ownerName: string | null
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

/**
 * 工作区的**控制面**（方案 B）：main 是 `ai_workspaces` 的唯一写方。
 *
 * - CRUD / `desired_status` 写表；
 * - 启动 / 停止 / 销毁转发给 workspace-service；
 * - 列表时向执行面查一次实时运行态，**不把运行态写回表**。
 *
 * 归属口径（`docs/design/workspace-cli-credentials.md` §9.1）：
 * - 归属由调用方身份推导（`currentOwner()`），**不写死 `admin`** —— 用户端同样需要有工作区；
 * - 过滤条件一律从 `scopeOf()` 取（超管不过滤，其余只认自己的），禁止散写 `if (isGod)`。
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

  /**
   * 确保主体有一条默认工作区（幂等；建号 / 首次建会话 / 补偿任务共用）。
   *
   * 用户端没有"建工作区"入口，默认工作区就在**首次建会话**时懒创建：
   * 否则用户登录后拿不到工作区，`bash` 只会返回「会话还没有绑定工作区」。
   */
  async ensureDefault(owner: OwnerRef): Promise<void> {
    const existing = await this.repo().findOne({
      where: { ...owner, isDefault: true },
      select: { id: true },
    })
    if (existing) return
    try {
      // 必须走 save(create(...)) 而不是 insert(...)：`@BeforeInsert`（生成 id）在
      // InsertQueryBuilder 里不会执行，直接用 insert 会撞 `id NOT NULL`（踩过）。
      const repo = this.repo()
      await repo.save(
        repo.create({
          ...owner,
          name: '默认工作区',
          isDefault: true,
          backend: 'container',
          image: null,
          location: null,
          fileAccess: 'write',
          desiredStatus: 'stopped',
        }),
      )
    } catch (error) {
      // 并发首建（同一主体的两条请求同时走到这里）：唯一索引挡住第二次插入，
      // 此时对方已经建好，等同幂等成功；查不到才算真失败。
      const now = await this.repo()
        .findOne({ where: { ...owner, isDefault: true }, select: { id: true } })
        .catch(() => null)
      if (now) return
      throw error
    }
    this.logger.log('workspace.default_created', {
      ownerType: owner.ownerType,
      ownerId: owner.ownerId,
    })
  }

  async list(owner: OwnerRef): Promise<WorkspaceModel[]> {
    const rows = await this.repo().find({
      where: scopeOf(owner),
      order: { isDefault: 'DESC', createdAt: 'ASC' },
    })
    return Promise.all(rows.map((row) => this.toModel(row)))
  }

  async create(owner: OwnerRef, input: WorkspaceCreateInput): Promise<WorkspaceModel> {
    await this.ensureDefault(owner)
    const repo = this.repo()
    // 同 ensureDefault：id 由 BaseEntity 的 `@BeforeInsert` 生成，必须先用 `create()`
    // 变成实体实例。直接 `save({...})` 普通对象不会跑实体钩子，插入时 id 走 DEFAULT = NULL，
    // 撞 `id NOT NULL`（2026-11-21 实测报错）。
    const entity = await repo.save(
      repo.create({
        ...owner,
        name: input.name?.trim() || '未命名工作区',
        isDefault: false,
        backend: input.backend ?? 'container',
        image: input.image?.trim() || null,
        location: null,
        fileAccess: input.fileAccess ?? 'write',
        desiredStatus: 'stopped',
      }),
    )
    return this.toModel(entity)
  }

  async update(owner: OwnerRef, id: string, input: WorkspaceUpdateInput): Promise<WorkspaceModel> {
    const row = await this.requireOwned(owner, id)
    await this.repo().update(
      { id: row.id },
      {
        ...(input.name === undefined ? {} : { name: input.name.trim() || row.name }),
        ...(input.image === undefined ? {} : { image: input.image?.trim() || null }),
        ...(input.fileAccess === undefined ? {} : { fileAccess: input.fileAccess }),
      },
    )
    return this.toModel(await this.requireOwned(owner, id))
  }

  async remove(owner: OwnerRef, id: string): Promise<{ removed: boolean }> {
    const row = await this.requireOwned(owner, id)
    // 默认工作区不能删是**业务规则**，不是"找不到"：400 + 明确文案
    if (row.isDefault) throw new DefaultWorkspaceUndeletableError()
    await this.client.destroy(row.id).catch((error: unknown) => {
      this.logger.warn('workspace.destroy_failed', {
        workspaceId: row.id,
        reason: error instanceof Error ? error.message : String(error),
      })
    })
    await this.repo().softDelete({ id: row.id })
    return { removed: true }
  }

  async start(owner: OwnerRef, id: string): Promise<WorkspaceModel> {
    const row = await this.requireOwned(owner, id)
    try {
      await this.client.ensure(row.id)
      await this.repo().update({ id: row.id }, { desiredStatus: 'running', lastUsedAt: new Date() })
      return await this.toModel(await this.requireOwned(owner, id))
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      this.logger.error('workspace.start_failed', { workspaceId: row.id, reason })
      throw new BadRequestException(`启动工作区失败：${reason}`)
    }
  }

  async stop(owner: OwnerRef, id: string): Promise<WorkspaceModel> {
    const row = await this.requireOwned(owner, id)
    await this.client.stop(row.id)
    await this.repo().update({ id: row.id }, { desiredStatus: 'stopped' })
    return this.toModel(await this.requireOwned(owner, id))
  }

  private async requireOwned(owner: OwnerRef, id: string): Promise<AiWorkspaceEntity> {
    const row = await this.repo().findOne({ where: { id, ...scopeOf(owner) } })
    if (!row) throw new WorkspaceNotFoundError(id)
    return row
  }

  /** 归属人的展示名（邮箱）：超管列表里用来区分「这是谁的工作区」 */
  private async ownerNameOf(row: AiWorkspaceEntity): Promise<string | null> {
    const entity = row.ownerType === 'user' ? UserEntity : AdminEntity
    const found = await this.db
      .getRepository(entity)
      .findOne({ where: { id: row.ownerId }, select: { email: true } })
      .catch(() => null)
    return found?.email ?? null
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
      ownerType: row.ownerType === 'user' ? 'user' : 'admin',
      ownerId: row.ownerId,
      ownerName: await this.ownerNameOf(row),
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
