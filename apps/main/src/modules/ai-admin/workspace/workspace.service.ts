import { BadRequestException, Inject, Injectable, Optional } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { AppLogger, Db } from '@repo/kits'
import { AdminEntity, AiWorkspaceEntity, UserEntity } from '@repo/db'
import { WorkspaceServiceClient } from '@repo/internal-sdk'
import type { WorkspaceBackend, WorkspaceFileAccess } from '@repo/contracts'
import type {
  WorkspaceFileBlobModel,
  WorkspaceFileContentModel,
  WorkspaceFileEntry,
  WorkspaceFilesModel,
} from '@repo/shared'
import { scopeOf, type OwnerRef } from '../../../common/security/index.js'
import {
  DefaultWorkspaceUndeletableError,
  WorkspaceHostRootInvalidError,
  WorkspaceNotFoundError,
} from './workspace.errors.js'

/** 文件预览上限：超过就拒绝，不把大文件塞进 HTTP / 浏览器 */
const FILE_PREVIEW_MAX_BYTES = 512 * 1024
/** 下载上限（base64 会膨胀 1/3，8MB 已经是一次很重的响应） */
const FILE_DOWNLOAD_MAX_BYTES = 8 * 1024 * 1024
/** 浏览深度与噪音目录（依赖 / 构建 / 缓存；与文件面板同一批） */
const BROWSE_MAX_DEPTH = 8
const BROWSE_EXCLUDE_DIRS = [
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  'target',
  'coverage',
  '.next',
  '.turbo',
  '.cache',
  '.pnpm-store',
  '__pycache__',
  '.venv',
  'venv',
  '.gradle',
]

export interface WorkspaceModel {
  id: string
  ownerType: 'user' | 'admin'
  ownerId: string
  ownerName: string | null
  name: string
  isDefault: boolean
  backend: WorkspaceBackend
  image: string | null
  /** 执行驱动：host / docker / kubernetes；空 = 推导 */
  driver: 'host' | 'container' | 'pod' | null
  /** 宿主目录（仅 `local`）：绝对路径；空 = 平台托管目录 */
  root: string | null
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
  driver?: 'host' | 'container' | 'pod'
  /** 宿主目录：仅 `local` 后端可填 */
  root?: string
  fileAccess?: WorkspaceFileAccess
}

export interface WorkspaceUpdateInput {
  name?: string
  image?: string | null
  /** `null` = 回到部署默认运行时 */
  driver?: 'host' | 'container' | 'pod' | null
  /** `null` = 清空，回到平台托管目录 */
  root?: string | null
  fileAccess?: WorkspaceFileAccess
}

/**
 * 宿主目录的**语法**校验（存在性 / 允许根 / 是否目录由执行面校验）。
 *
 * 返回归一后的绝对路径；空值返回 null。`/` 与含 `..` 的路径一律拒绝：
 * 前者等于把整个宿主交给工作区，后者会让「允许根之内」的包含关系变得不可静态判断。
 */
const driverMatches = (backend: WorkspaceBackend, driver: 'host' | 'container' | 'pod'): boolean =>
  driver === 'host' ? backend === 'local' : backend === 'container'

const normalizeHostRoot = (raw: string | null | undefined): string | null => {
  if (raw === undefined || raw === null) return null
  const value = raw.trim()
  if (!value) return null
  if (value.length > 512) throw new WorkspaceHostRootInvalidError('路径过长（上限 512 字符）')
  if (!value.startsWith('/')) throw new WorkspaceHostRootInvalidError('必须是绝对路径')
  if (value === '/') throw new WorkspaceHostRootInvalidError('不能是整个根目录 /')
  if (value.includes('\0')) throw new WorkspaceHostRootInvalidError('路径含非法字符')
  if (value.split('/').includes('..')) throw new WorkspaceHostRootInvalidError('不能含 .. 段')
  return value.replace(/\/+$/, '') || '/'
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
    // 工作区默认值（后端 / 驱动）来自部署配置；手工构造的测试不传时按环境变量兜底
    @Optional() @Inject(ConfigService) private readonly config?: ConfigService,
  ) {}

  private workspaceAdminDefaults(): { defaultDriver: 'host' | 'container' | 'pod' } {
    const fromConfig = this.config?.get<{ defaultDriver?: 'host' | 'container' | 'pod' }>(
      'workspaceAdmin',
    )
    const raw = fromConfig?.defaultDriver ?? process.env.WORKSPACE_DEFAULT_DRIVER?.trim()
    return { defaultDriver: raw === 'host' || raw === 'pod' ? raw : 'container' }
  }

  /**
   * 新建工作区会落在哪：给界面「会保存在 …」那行用。
   *
   * 用户不需要知道路径细节，这里只回答「容器内」还是「本机自动分配的目录」。
   */
  async defaults(): Promise<{ driver: 'host' | 'container' | 'pod'; location: string }> {
    const { defaultDriver } = this.workspaceAdminDefaults()
    if (defaultDriver !== 'host') {
      const label = defaultDriver === 'pod' ? 'Kubernetes Pod' : 'Docker 容器'
      return { driver: defaultDriver, location: `${label}内（停止后清空）` }
    }
    const info: Record<string, unknown> = await this.client.info().catch(() => ({}))
    const root = typeof info.localRoot === 'string' ? info.localRoot : null
    return {
      driver: 'host',
      location: root ? `本机 ${root}/<工作区 ID>` : '本机（自动分配目录）',
    }
  }

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
          // 驱动由部署决定（无 Docker 的单机部署设 WORKSPACE_DEFAULT_DRIVER=host）
          backend: this.workspaceAdminDefaults().defaultDriver === 'host' ? 'local' : 'container',
          driver: this.workspaceAdminDefaults().defaultDriver,
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

  /** 执行面的部署级信息（只读代理）：后台用来提示「沙箱关着 / 用 k8s」这类部署事实 */
  serverInfo(): Promise<Record<string, unknown>> {
    return this.client.info().catch(() => ({}))
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
    const defaults = this.workspaceAdminDefaults()
    const backend = input.backend ?? (defaults.defaultDriver === 'host' ? 'local' : 'container')
    // 没显式给 driver 时按后端补：local → host；container → 部署默认（host 不适用于容器）
    const driver =
      input.driver ??
      (backend === 'local'
        ? 'host'
        : defaults.defaultDriver === 'host'
          ? 'container'
          : defaults.defaultDriver)
    const root = normalizeHostRoot(input.root)
    if (root && backend !== 'local') {
      throw new WorkspaceHostRootInvalidError('宿主目录只能配在 local 后端的工作区上')
    }
    if (!driverMatches(backend, driver)) {
      throw new WorkspaceHostRootInvalidError(
        '执行驱动与后端不匹配（host 配 local，container/pod 配 container）',
      )
    }
    // 同 ensureDefault：id 由 BaseEntity 的 `@BeforeInsert` 生成，必须先用 `create()`
    // 变成实体实例。直接 `save({...})` 普通对象不会跑实体钩子，插入时 id 走 DEFAULT = NULL，
    // 撞 `id NOT NULL`（2026-11-21 实测报错）。
    const entity = await repo.save(
      repo.create({
        ...owner,
        name: input.name?.trim() || '未命名工作区',
        isDefault: false,
        backend,
        image: input.image?.trim() || null,
        driver: backend === 'local' ? 'host' : driver,
        location: root ? { root } : null,
        fileAccess: input.fileAccess ?? 'write',
        desiredStatus: 'stopped',
      }),
    )
    return this.toModel(entity)
  }

  async update(owner: OwnerRef, id: string, input: WorkspaceUpdateInput): Promise<WorkspaceModel> {
    const row = await this.requireOwned(owner, id)
    // `undefined` = 不改；`null` = 清空回平台托管目录
    let location: Record<string, unknown> | null | undefined
    if (input.root !== undefined) {
      if (row.backend !== 'local') {
        throw new WorkspaceHostRootInvalidError('宿主目录只能配在 local 后端的工作区上')
      }
      const root = normalizeHostRoot(input.root)
      location = root ? { root } : null
    }
    if (input.driver !== undefined) {
      // 驱动创建时定死：换驱动等于换一套环境，旧环境的数据不会迁移，静默切换最坑人
      const current =
        row.driver === 'host' || row.driver === 'container' || row.driver === 'pod'
          ? row.driver
          : row.backend === 'local'
            ? 'host'
            : 'container'
      if (input.driver !== current) {
        throw new BadRequestException('工作区驱动创建后不能更改：需要别的驱动请新建工作区')
      }
    }
    // 走 `save(row)` 而不是 `repo.update({...})`：jsonb 列在 `_QueryDeepPartialEntity` 下
    // 不接受 `Record<string, unknown>`（同 credential-audit.repository 的取舍）。
    if (input.name !== undefined) row.name = input.name.trim() || row.name
    if (input.image !== undefined) row.image = input.image?.trim() || null
    if (input.fileAccess !== undefined) row.fileAccess = input.fileAccess
    if (location !== undefined) row.location = location
    await this.repo().save(row)
    return this.toModel(row)
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

  /**
   * 工作区文件树（**只读**）：后台卡片上「文件」弹窗用。
   *
   * `fs` 内部会 `ensureHandle`（等于拉起容器），所以先查运行态：
   * 停止的工作区直接说明，不背着用户启动。
   */
  async files(owner: OwnerRef, id: string): Promise<WorkspaceFilesModel> {
    const row = await this.requireOwned(owner, id)
    await this.assertRunning(row.id)
    const result = await this.client.fs({
      workspaceId: row.id,
      op: 'list-tree',
      path: '.',
      maxDepth: BROWSE_MAX_DEPTH,
      excludeDirs: BROWSE_EXCLUDE_DIRS,
    })
    if (!result.ok) throw new BadRequestException(result.message ?? '读取工作区文件失败')
    const entries = (result.data as { entries?: WorkspaceFileEntry[] } | undefined)?.entries ?? []
    return { entries }
  }

  /** 读单个文件正文（文本预览）：先 `stat` 看体积，超上限直接拒绝 */
  async readFile(owner: OwnerRef, id: string, path: string): Promise<WorkspaceFileContentModel> {
    const row = await this.requireOwned(owner, id)
    await this.assertRunning(row.id)
    const info = await this.client.fs({ workspaceId: row.id, op: 'stat', path })
    if (!info.ok) throw new BadRequestException(info.message ?? '读取文件失败')
    const meta = info.data as { type?: string; size?: number } | undefined
    if (meta?.type === 'dir') throw new BadRequestException('这是一个目录，不能预览')
    const size = meta?.size ?? 0
    if (size > FILE_PREVIEW_MAX_BYTES) {
      throw new BadRequestException(
        `文件 ${Math.ceil(size / 1024)}KB，超过在线预览上限 ${FILE_PREVIEW_MAX_BYTES / 1024}KB`,
      )
    }
    const result = await this.client.fs({ workspaceId: row.id, op: 'read', path })
    if (!result.ok) throw new BadRequestException(result.message ?? '读取文件失败')
    const data = result.data as { content?: string } | undefined
    return { path, content: data?.content ?? '', bytes: size }
  }

  /** 下载单个文件：字节转 base64 回给浏览器（只读；有体积上限） */
  async downloadFile(owner: OwnerRef, id: string, path: string): Promise<WorkspaceFileBlobModel> {
    const row = await this.requireOwned(owner, id)
    await this.assertRunning(row.id)
    const info = await this.client.fs({ workspaceId: row.id, op: 'stat', path })
    if (!info.ok) throw new BadRequestException(info.message ?? '读取文件失败')
    const meta = info.data as { type?: string; size?: number } | undefined
    if (meta?.type === 'dir') throw new BadRequestException('这是一个目录，不能下载')
    const size = meta?.size ?? 0
    if (size > FILE_DOWNLOAD_MAX_BYTES) {
      throw new BadRequestException(
        `文件 ${Math.ceil(size / 1024)}KB，超过下载上限 ${FILE_DOWNLOAD_MAX_BYTES / 1024 / 1024}MB`,
      )
    }
    const result = await this.client.fs({ workspaceId: row.id, op: 'read-bytes', path })
    if (!result.ok) throw new BadRequestException(result.message ?? '读取文件失败')
    const data = result.data as { base64?: string } | undefined
    return {
      path,
      filename: path.split('/').pop() ?? path,
      base64: data?.base64 ?? '',
      bytes: size,
    }
  }

  /** 运行态必须是 running：`fs` 会 ensureHandle，先拦掉「点开就偷偷启动」 */
  private async assertRunning(workspaceId: string): Promise<void> {
    const status = await this.client.status(workspaceId).catch(() => null)
    if (status?.state !== 'running') {
      throw new BadRequestException('工作区未运行，先启动再查看文件')
    }
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
      driver:
        row.driver === 'host' || row.driver === 'container' || row.driver === 'pod'
          ? row.driver
          : null,
      root: ((row.location as { root?: string } | null)?.root ?? null) || null,
      fileAccess: row.fileAccess as WorkspaceFileAccess,
      desiredStatus: row.desiredStatus as 'running' | 'stopped',
      runtime,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }
  }
}
