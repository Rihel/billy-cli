import { createHash } from 'node:crypto'
import { appendFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import {
  Inject,
  Injectable,
  Optional,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common'
import { AppLogger, ObjectStorage } from '@repo/kits'
import {
  buildFileTree,
  type AgentFileAdminListDto,
  type AgentFileAdminListModel,
  type AgentFileAdminQueryDto,
  type AgentFileAdminStatsModel,
  type AgentFileModel,
  type AgentFileNode,
  type ChatAttachmentModel,
} from '@repo/shared'
import { FILE_CAPS } from './file.types.js'
import { WORKSPACE_FS_PORT, type WorkspaceFsPort } from './workspace-fs.port.js'
import { FileDeniedError } from './file.errors.js'
import type { FileCaps } from './file.types.js'
import {
  conversationWorkspace,
  displayName,
  extensionOf,
  isTextFile,
  mediaTypeOf,
  normalizeFileKey,
  resolveWorkspacePath,
} from './workspace.js'
import {
  DEFAULT_FILE_CONFIG,
  normalizeFileConfig,
  type FileConfigValue,
  type AppendFileInputSchema,
  type DownloadInputSchema,
  type FileSearchInputSchema,
  type ReadFileInputSchema,
  type ReplaceFileInputSchema,
  type SubmitInputSchema,
  type WorkspaceFilesInputSchema,
  type WriteFileInputSchema,
} from './file.schemas.js'
import type { z } from 'zod'
import { FileRepository } from './file.repository.js'
import { PathLock } from './path-lock.js'

export interface FileContext {
  conversationId: string
  /** 所属工作区（执行面改造后，fs 原语按它路由；未绑定时缺省走本地根） */
  workspaceId?: string
  userId: string | null
  isAdmin: boolean
  runId: string | null
  toolCallId: string | null
  /** 工具侧传 `ctx.settings.config`；HTTP / 入站侧用默认值 */
  config?: FileConfigValue
}

type SubmitInput = z.infer<typeof SubmitInputSchema>
type DownloadInput = z.infer<typeof DownloadInputSchema>
type ReadFileInput = z.infer<typeof ReadFileInputSchema>
type FileSearchInput = z.infer<typeof FileSearchInputSchema>
type WorkspaceFilesInput = z.infer<typeof WorkspaceFilesInputSchema>
type WriteFileInput = z.infer<typeof WriteFileInputSchema>
type ReplaceFileInput = z.infer<typeof ReplaceFileInputSchema>
type AppendFileInput = z.infer<typeof AppendFileInputSchema>

/** 预览临时对象的保留时间：足够一次阅读，过后由后台清扫 */
const PREVIEW_TTL_MS = 24 * 60 * 60 * 1000
const PREVIEW_CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000
const PREVIEW_PREFIX = '_preview/'

/**
 * **噪音目录**：依赖 / 构建 / 缓存 / 编辑器产物。
 *
 * 不是安全边界（`bash` 照样能进去读写），只是为了「文件树 / 搜索 / 模型清单」可读：
 * 一个 `node_modules` 就能把工作区从 20 条撑到两万条，用户和模型都看不出真正的工作内容。
 *
 * 判断只按目录名（任何层级），所以 `vendor/` 放在哪儿都会被跳过 —— 需要看它们时用 `bash` 或
 * `pathPrefix` 直接指到具体位置以外的地方；真要列噪音目录，改这里而不是改面板。
 */
const NOISE_DIRS = new Set([
  // 版本控制 / 依赖
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  'bower_components',
  'vendor',
  '.pnpm-store',
  '.yarn',
  // 构建 / 产物
  'dist',
  'build',
  'out',
  'target',
  'coverage',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.output',
  '.turbo',
  '.parcel-cache',
  // 语言 / 工具缓存
  '__pycache__',
  '.mypy_cache',
  '.pytest_cache',
  '.venv',
  'venv',
  '.cache',
  '.gradle',
  '.idea',
  'Pods',
])

/** 噪音文件（纯系统产物，列出来只会干扰阅读） */
const NOISE_FILES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini'])

const isNoiseFile = (name: string): boolean =>
  NOISE_FILES.has(name) || name.endsWith('.pyc') || name.endsWith('.swp')

const sha256 = (body: Buffer): string => createHash('sha256').update(body).digest('hex')

const lineCount = (text: string): number => (text.length === 0 ? 0 : text.split('\n').length)

const isSensitiveName = (filename: string): boolean => {
  const base = filename.split('/').pop()?.toLowerCase() ?? ''
  return (
    base.startsWith('.env') ||
    base.startsWith('id_rsa') ||
    base.endsWith('.pem') ||
    base.endsWith('.key') ||
    base.endsWith('.p12') ||
    base.startsWith('credentials')
  )
}

const relPath = (root: string, target: string): string =>
  relative(root, target).split('\\').join('/')

/**
 * 文件管理的业务主体（设计 `docs/design/ai-file-manager.md`）。
 *
 * 边界：
 * - 对象存储只通过 `ObjectStorage` 统一入口；
 * - 元数据只通过 `FileRepository` 读写；
 * - 工作区路径一律过 `resolveWorkspacePath`（含软链判断）；
 * - 工具层只做参数 / 结果形状，业务动作都在这里，HTTP 侧复用同一套。
 */
@Injectable()
export class FileService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly locks = new PathLock()
  private cleanupTimer?: NodeJS.Timeout

  constructor(
    @Inject(ObjectStorage) private readonly storage: ObjectStorage,
    @Inject(FileRepository) private readonly files: FileRepository,
    @Inject(AppLogger) private readonly logger: AppLogger,
    @Optional() @Inject(FILE_CAPS) private readonly caps?: FileCaps,
    @Optional() @Inject(WORKSPACE_FS_PORT) private readonly fsPort?: WorkspaceFsPort,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.storage.enabled) return
    // 启动先清一次；之后每 6 小时扫一次。失败不影响服务。
    void this.cleanupPreviews()
    this.cleanupTimer = setInterval(() => {
      void this.cleanupPreviews()
    }, PREVIEW_CLEANUP_INTERVAL_MS)
    this.cleanupTimer.unref?.()
  }

  onApplicationShutdown(): void {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer)
  }

  /**
   * 清理 `_preview/` 下超过 TTL 的物化对象。
   *
   * 这些对象是 workspace 文件为了“浏览器直连”临时写进 OSS 的，不是用户文件；
   * 留在桶里只会越积越多。预览请求路径不删除它们（正在看的人链接会断），交给后台清扫。
   */
  async cleanupPreviews(now = Date.now()): Promise<number> {
    try {
      const objects = await this.storage.listObjects({
        prefix: PREVIEW_PREFIX,
        max: 1000,
      })
      const expired = objects.filter(
        (object) => now - object.lastModified.getTime() > PREVIEW_TTL_MS,
      )
      for (const object of expired) {
        await this.storage.removeObject({ key: object.key })
      }
      if (expired.length > 0) {
        this.logger.log('ai.file.preview_cleanup', { removed: expired.length })
      }
      return expired.length
    } catch (error) {
      this.logger.warn('ai.file.preview_cleanup_failed', {
        reason: error instanceof Error ? error.message : String(error),
      })
      return 0
    }
  }

  private configOf(ctx: FileContext): FileConfigValue {
    return ctx.config ?? normalizeFileConfig(DEFAULT_FILE_CONFIG, this.caps)
  }

  private workspaceOf(ctx: FileContext): string {
    return conversationWorkspace(this.caps, ctx.conversationId)
  }

  /** 工作区文件系统端口：有远程实现时走它，否则本地 fs（自托管 / 未接执行面） */
  private relPath(ctx: FileContext, target: string): string {
    return relPath(this.workspaceOf(ctx), target)
  }

  /** 端口路径：工作区根是空串，契约要求非空 → 统一成 `.` */
  private portPath(ctx: FileContext, target: string): string {
    const rel = this.relPath(ctx, target)
    return rel === '' ? '.' : rel
  }

  private async readBytesOf(ctx: FileContext, target: string): Promise<Buffer> {
    if (this.fsPort && ctx.workspaceId) {
      return this.fsPort.readBytes(ctx.workspaceId, this.portPath(ctx, target))
    }
    return readFile(target)
  }

  private async writeBytesOf(ctx: FileContext, target: string, body: Buffer): Promise<void> {
    if (this.fsPort && ctx.workspaceId) {
      await this.fsPort.writeBytes(ctx.workspaceId, this.portPath(ctx, target), body)
      return
    }
    await mkdir(dirname(target), { recursive: true })
    await this.atomicWrite(target, body)
  }

  private async readTextOf(ctx: FileContext, target: string): Promise<string> {
    if (this.fsPort && ctx.workspaceId) {
      return this.fsPort.readText(ctx.workspaceId, this.portPath(ctx, target))
    }
    return readFile(target, 'utf8')
  }

  private async writeTextOf(ctx: FileContext, target: string, content: string): Promise<void> {
    if (this.fsPort && ctx.workspaceId) {
      await this.fsPort.writeText(ctx.workspaceId, this.portPath(ctx, target), content)
      return
    }
    await mkdir(dirname(target), { recursive: true })
    await this.atomicWrite(target, Buffer.from(content, 'utf8'))
  }

  private async appendTextOf(ctx: FileContext, target: string, content: string): Promise<void> {
    if (this.fsPort && ctx.workspaceId) {
      await this.fsPort.appendText(ctx.workspaceId, this.portPath(ctx, target), content)
      return
    }
    await mkdir(dirname(target), { recursive: true })
    await appendFile(target, content, { mode: 0o600 })
  }

  private async statOf(
    ctx: FileContext,
    target: string,
  ): Promise<{ isDirectory(): boolean; isFile(): boolean; size: number; mtime: Date } | null> {
    if (this.fsPort && ctx.workspaceId) {
      try {
        const info = await this.fsPort.stat(ctx.workspaceId, this.portPath(ctx, target))
        return {
          isDirectory: () => info.type === 'dir',
          isFile: () => info.type === 'file',
          size: info.size,
          mtime: new Date(info.mtime ?? 0),
        }
      } catch {
        return null
      }
    }
    const info = await stat(target).catch(() => null)
    if (!info) return null
    return {
      isDirectory: () => info.isDirectory(),
      isFile: () => info.isFile(),
      size: info.size,
      mtime: info.mtime,
    }
  }

  /** 目录项：有远程实现时走 port.list，否则本地 readdir */
  private async readdirOf(
    ctx: FileContext,
    dir: string,
  ): Promise<
    Array<{ name: string; isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean }>
  > {
    if (this.fsPort && ctx.workspaceId) {
      const rel = this.relPath(ctx, dir)
      const entries = await this.fsPort.list(ctx.workspaceId, rel === '' ? '.' : rel)
      return entries.map((entry) => ({
        name: entry.name,
        isDirectory: () => entry.type === 'dir',
        isFile: () => entry.type === 'file',
        isSymbolicLink: () => false,
      }))
    }
    return readdir(dir, { withFileTypes: true }).catch(() => [])
  }

  /** 会话详情用：把 `ai_files` 组装成树 */
  async tree(conversationId: string): Promise<AgentFileNode[]> {
    const rows = await this.files.list(conversationId)
    return buildFileTree(rows.map((row) => this.files.toModel(row)))
  }

  /** 后台独立文件页：全量列表 + 所属会话标题 */
  async adminList(input: AgentFileAdminListDto): Promise<AgentFileAdminListModel> {
    return this.files.adminList(input)
  }

  /** 后台独立文件页：总量统计（与列表共用筛选） */
  async adminStats(input: AgentFileAdminQueryDto): Promise<AgentFileAdminStatsModel> {
    return this.files.adminStats(input)
  }

  /** `file-list`：只回元数据，不回 key */
  async list(conversationId: string): Promise<{
    items: Array<Omit<AgentFileModel, 'key'>>
    total: number
  }> {
    const rows = await this.files.list(conversationId)
    const items = rows.map((row) => {
      const model = this.files.toModel(row)
      return {
        path: model.path,
        source: model.source,
        filename: model.filename,
        bytes: model.bytes,
        mediaType: model.mediaType,
        sha256: model.sha256,
        createdAt: model.createdAt,
        updatedAt: model.updatedAt,
      }
    })
    return { items, total: items.length }
  }

  /** `file-submit`：工作区文件 → OSS，登记 `source='ai'` */
  async submit(
    ctx: FileContext,
    input: SubmitInput,
  ): Promise<{
    fileKey: string
    key: string
    fileId: string
    source: 'ai'
    bytes: number
    mediaType: string
    sha256: string
    replaced: boolean
  }> {
    const config = this.configOf(ctx)
    const filePath = await resolveWorkspacePath({
      caps: this.caps,
      conversationId: ctx.conversationId,
      path: input.filePath,
    })
    const info = await this.statOf(ctx, filePath)
    if (!info?.isFile()) {
      throw new FileDeniedError('invalid-input', `不是普通文件：${input.filePath}`)
    }
    if (info.size <= 0) throw new FileDeniedError('invalid-input', '不能提交空文件')
    if (info.size > config.maxBytes) {
      throw new FileDeniedError(
        'invalid-input',
        `文件超过单文件上限 ${Math.round(config.maxBytes / 1024 / 1024)}MB`,
      )
    }
    if (isSensitiveName(filePath)) {
      throw new FileDeniedError('invalid-input', '该文件看起来是密钥 / 凭据，不允许提交')
    }

    const fileKey = normalizeFileKey(input.fileKey)
    if (fileKey === 'uploads' || fileKey.startsWith('uploads/')) {
      throw new FileDeniedError('invalid-input', 'fileKey 不能以 uploads/ 开头（保留给用户上传）')
    }

    return this.locks.run(`${ctx.conversationId}:${fileKey}`, async () => {
      const body = await this.readBytesOf(ctx, filePath)
      const digest = sha256(body)
      const existing = await this.files.find(ctx.conversationId, fileKey)
      if (existing?.sha256 === digest) {
        return {
          fileKey,
          key: existing.key,
          fileId: existing.id,
          source: 'ai' as const,
          bytes: existing.bytes,
          mediaType: existing.mediaType,
          sha256: digest,
          replaced: false,
        }
      }

      const quota = await this.files.countAndBytes(
        ctx.conversationId,
        existing ? fileKey : undefined,
      )
      if (quota.count >= config.maxFilesPerConversation) {
        throw new FileDeniedError(
          'invalid-input',
          `本会话文件已达上限 ${config.maxFilesPerConversation} 个`,
        )
      }
      if (quota.bytes + body.length > config.maxTotalBytesPerConversation) {
        throw new FileDeniedError(
          'invalid-input',
          `本会话文件总量超过上限 ${Math.round(config.maxTotalBytesPerConversation / 1024 / 1024)}MB`,
        )
      }

      const key = this.objectKey(ctx, fileKey)
      const mediaType = mediaTypeOf(fileKey)
      await this.storage.putObject({ key, body, contentType: mediaType })
      try {
        const row = await this.files.upsert({
          conversationId: ctx.conversationId,
          source: 'ai',
          path: fileKey,
          filename: displayName(fileKey),
          key,
          mediaType,
          bytes: body.length,
          sha256: digest,
          userId: ctx.userId,
          runId: ctx.runId,
          toolCallId: ctx.toolCallId,
        })
        return {
          fileKey,
          key,
          fileId: row.id,
          source: 'ai' as const,
          bytes: row.bytes,
          mediaType: row.mediaType,
          sha256: digest,
          replaced: Boolean(existing),
        }
      } catch (error) {
        // 新路径才清孤儿；覆盖路径删了会把旧对象也弄没
        if (!existing) await this.storage.removeObject({ key }).catch(() => undefined)
        throw error
      }
    })
  }

  /** `file-download`：OSS → 工作区；返回路径，不返回内容 */
  async download(
    ctx: FileContext,
    input: DownloadInput,
  ): Promise<{
    fileKey: string
    key: string
    source: 'user' | 'ai'
    filename: string
    path: string
    bytes: number
    sha256: string | null
    cached: boolean
  }> {
    const config = this.configOf(ctx)
    const row = await this.files.find(ctx.conversationId, input.fileKey)
    if (!row) throw new FileDeniedError('forbidden', '本会话没有这个文件')
    if (row.bytes > config.readMaxBytes) {
      throw new FileDeniedError('invalid-input', `文件超过读取上限 ${config.readMaxBytes} 字节`)
    }
    const source = row.source === 'user' ? ('user' as const) : ('ai' as const)
    const defaultPath = source === 'user' ? row.path : `files/${row.path}`
    const target = await resolveWorkspacePath({
      caps: this.caps,
      conversationId: ctx.conversationId,
      path: input.filePath ?? defaultPath,
      allowMissing: true,
    })
    const existing = await this.statOf(ctx, target)
    if (existing?.isFile()) {
      if (row.sha256) {
        const current = sha256(await this.readBytesOf(ctx, target))
        if (current === row.sha256) {
          return {
            fileKey: row.path,
            key: row.key,
            source,
            filename: row.filename,
            path: target,
            bytes: row.bytes,
            sha256: row.sha256,
            cached: true,
          }
        }
      } else if (existing.size === row.bytes) {
        return {
          fileKey: row.path,
          key: row.key,
          source,
          filename: row.filename,
          path: target,
          bytes: row.bytes,
          sha256: row.sha256,
          cached: true,
        }
      }
    }

    const object = await this.storage.getObject({ key: row.key })
    if (row.sha256 && sha256(object.body) !== row.sha256) {
      throw new FileDeniedError(
        'upstream',
        '对象已损坏（sha256 不匹配），请重新提交',
        undefined,
        true,
      )
    }
    await this.writeBytesOf(ctx, target, object.body)
    return {
      fileKey: row.path,
      key: row.key,
      source,
      filename: row.filename,
      path: target,
      bytes: object.body.length,
      sha256: row.sha256,
      cached: false,
    }
  }

  /** `read-file`：工作区文本分页 */
  async readFile(
    ctx: FileContext,
    input: ReadFileInput,
  ): Promise<{
    path: string
    totalLines: number
    offset: number
    limit: number
    text: string
    hasMore: boolean
    nextOffset: number
    truncated: boolean
  }> {
    const config = this.configOf(ctx)
    const target = await resolveWorkspacePath({
      caps: this.caps,
      conversationId: ctx.conversationId,
      path: input.filePath,
    })
    const info = await this.statOf(ctx, target)
    if (!info?.isFile()) throw new FileDeniedError('invalid-input', '不是普通文件')
    if (info.size > config.readMaxBytes) {
      throw new FileDeniedError('invalid-input', `文件超过读取上限 ${config.readMaxBytes} 字节`)
    }
    if (!isTextFile(target)) {
      throw new FileDeniedError('invalid-input', 'read-file 只读文本文件；二进制用 bash / python')
    }

    const lines = (await this.readTextOf(ctx, target)).split('\n')
    const totalLines = lines.length
    const offset = Math.max(1, input.offset ?? 1)
    const limit = Math.min(input.limit ?? config.pageLines, 500)
    if (offset > totalLines) {
      return {
        path: target,
        totalLines,
        offset,
        limit,
        text: '',
        hasMore: false,
        nextOffset: offset,
        truncated: false,
      }
    }

    const page: string[] = []
    let chars = 0
    let truncated = false
    for (let index = offset - 1; index < totalLines && page.length < limit; index += 1) {
      let line = lines[index]
      if (line.length > config.maxPageChars) {
        line = line.slice(0, config.maxPageChars)
        truncated = true
      }
      if (page.length > 0 && chars + line.length + 1 > config.maxPageChars) {
        truncated = true
        break
      }
      page.push(line)
      chars += line.length + 1
    }
    const nextOffset = offset + page.length
    return {
      path: target,
      totalLines,
      offset,
      limit,
      text: page.join('\n'),
      hasMore: nextOffset <= totalLines,
      nextOffset,
      truncated,
    }
  }

  /** `file-search`：整个工作区按空格分隔的多关键词（AND）搜索 */
  async search(
    ctx: FileContext,
    input: FileSearchInput,
  ): Promise<{
    items: Array<{ filePath: string; line: number; text: string }>
    totalMatches: number
    truncated: boolean
    scannedFiles: number
  }> {
    const config = this.configOf(ctx)
    const keywords = Array.from(
      new Set(
        input.keywords
          .split(/\s+/)
          .map((word) => word.trim())
          .filter(Boolean),
      ),
    )
    if (keywords.length === 0) throw new FileDeniedError('invalid-input', 'keywords 不能为空')
    if (keywords.length > config.searchMaxKeywords) {
      throw new FileDeniedError('invalid-input', `关键词最多 ${config.searchMaxKeywords} 个`)
    }
    if (keywords.some((word) => word.length > 50)) {
      throw new FileDeniedError('invalid-input', '每个关键词最多 50 字符')
    }
    const needle = keywords.map((word) => (input.caseSensitive ? word : word.toLowerCase()))
    const maxResults = Math.min(
      input.maxResults ?? config.searchMaxResults,
      config.searchMaxResults,
    )
    const root = this.workspaceOf(ctx)
    const start = input.pathPrefix
      ? await resolveWorkspacePath({
          caps: this.caps,
          conversationId: ctx.conversationId,
          path: input.pathPrefix,
        })
      : root

    const items: Array<{ filePath: string; line: number; text: string }> = []
    let totalMatches = 0
    let scannedFiles = 0
    let scannedBytes = 0
    let truncated = false

    const scanFile = async (file: string): Promise<void> => {
      if (truncated) return
      const info = await stat(file).catch(() => null)
      if (!info?.isFile()) return
      if (info.size > config.readMaxBytes) return
      const rel = relPath(root, file)
      if (!isTextFile(rel, mediaTypeOf(rel))) return
      scannedFiles += 1
      scannedBytes += info.size
      if (scannedFiles > config.searchMaxFiles || scannedBytes > config.searchMaxBytes) {
        truncated = true
        return
      }
      const content = await this.readTextOf(ctx, file).catch(() => null)
      if (content === null) return
      const lines = content.split('\n')
      for (let index = 0; index < lines.length; index += 1) {
        const raw = lines[index]
        const haystack = input.caseSensitive ? raw : raw.toLowerCase()
        if (!needle.every((word) => haystack.includes(word))) continue
        totalMatches += 1
        if (items.length >= maxResults) {
          truncated = true
          return
        }
        items.push({
          filePath: rel,
          line: index + 1,
          text: raw.slice(0, config.searchMaxLineChars),
        })
      }
    }

    const walk = async (dir: string, depth: number): Promise<void> => {
      if (truncated || depth > config.workspaceMaxDepth) {
        truncated = truncated || depth > config.workspaceMaxDepth
        return
      }
      const entries = await this.readdirOf(ctx, dir)
      for (const entry of entries) {
        if (truncated) return
        if (entry.isSymbolicLink()) continue
        const full = resolve(dir, entry.name)
        if (entry.isDirectory()) {
          if (NOISE_DIRS.has(entry.name)) continue
          await walk(full, depth + 1)
        } else if (entry.isFile()) {
          if (isNoiseFile(entry.name)) continue
          await scanFile(full)
        }
      }
    }

    const startInfo = await stat(start).catch(() => null)
    if (!startInfo) {
      if (!input.pathPrefix)
        return { items: [], totalMatches: 0, truncated: false, scannedFiles: 0 }
      throw new FileDeniedError('invalid-input', `目录不存在：${input.pathPrefix}`)
    }
    if (startInfo.isDirectory()) await walk(start, 0)
    else await scanFile(start)

    return { items, totalMatches, truncated, scannedFiles }
  }

  /**
   * `workspace-files`：工作区扁平清单（**一维数组**，树由调用方自己拼）。
   *
   * 两种取法：
   * - 默认按页取（一页 = `workspaceMaxFiles`），`hasMore=true` 时带 `offset` 继续翻 ——
   *   **模型工具走这条**：一次几千条会白烧 token，让它自己决定要不要翻页；
   * - `all=true` 一次返回全部 —— **右栏文件树走这条**：树要「一次成型」，半加载的树
   *   会让用户以为文件少了，翻页控件放在树下面也很难用；面板本来就要全量才能建树。
   *
   * 顺序必须**确定**：目录项按名字排好再深度优先，否则两次调用的边界会错位（同一文件
   * 可能翻到两遍、也可能一次都翻不到）。这里不用 `localeCompare`（结果依赖 ICU / 语言环境），
   * 直接用码位比较，任何机器上顺序都一样。
   */
  async workspaceFiles(
    ctx: FileContext,
    input: WorkspaceFilesInput & { all?: boolean },
  ): Promise<{
    items: Array<{ path: string; bytes: number; mtime: string }>
    total: number
    hasMore: boolean
    depthLimited: boolean
  }> {
    const config = this.configOf(ctx)
    const pageSize =
      input.all === true ? Number.MAX_SAFE_INTEGER : Math.max(1, config.workspaceMaxFiles)
    const offset = Math.max(0, input.offset ?? 0)
    const root = this.workspaceOf(ctx)
    const start = input.pathPrefix
      ? await resolveWorkspacePath({
          caps: this.caps,
          conversationId: ctx.conversationId,
          path: input.pathPrefix,
        })
      : root
    const includeCaches =
      input.includeCaches === true ||
      (input.pathPrefix?.startsWith('files/') ?? false) ||
      (input.pathPrefix?.startsWith('uploads/') ?? false)

    const items: Array<{ path: string; bytes: number; mtime: string }> = []
    /** 已经路过的文件数（用于跳过 offset 之前的页） */
    let cursor = 0
    let hasMore = false
    /** 深度上限截掉了更深的目录：与「还有下一页」是两件事，分开报 */
    let depthLimited = false

    const walk = async (dir: string, depth: number): Promise<void> => {
      if (hasMore) return
      if (depth > config.workspaceMaxDepth) {
        depthLimited = true
        return
      }
      const entries = await this.readdirOf(ctx, dir)
      entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
      for (const entry of entries) {
        if (hasMore) return
        if (entry.isSymbolicLink()) continue
        const full = resolve(dir, entry.name)
        if (entry.isDirectory()) {
          if (NOISE_DIRS.has(entry.name)) continue
          if (
            !includeCaches &&
            depth === 0 &&
            (entry.name === 'files' || entry.name === 'uploads')
          ) {
            continue
          }
          await walk(full, depth + 1)
        } else if (entry.isFile()) {
          // 噪音文件不算进页码：否则 offset 会把「文件真的少了」和「被过滤了」混在一起
          if (isNoiseFile(entry.name)) continue
          const info = await this.statOf(ctx, full)
          if (!info) continue
          if (cursor < offset) {
            cursor += 1
            continue
          }
          if (items.length >= pageSize) {
            hasMore = true
            return
          }
          cursor += 1
          items.push({
            path: relPath(root, full),
            bytes: info.size,
            mtime: info.mtime.toISOString(),
          })
        }
      }
    }

    const startInfo = await this.statOf(ctx, start)
    if (!startInfo) {
      if (!input.pathPrefix) return { items: [], total: 0, hasMore: false, depthLimited: false }
      throw new FileDeniedError('invalid-input', `目录不存在：${input.pathPrefix}`)
    }
    if (startInfo.isDirectory()) await walk(start, 0)
    else if (offset === 0 && !isNoiseFile(displayName(start))) {
      const info = await this.statOf(ctx, start)
      if (info) {
        items.push({
          path: relPath(root, start),
          bytes: info.size,
          mtime: info.mtime.toISOString(),
        })
      }
    }

    return { items, total: items.length, hasMore, depthLimited }
  }

  /**
   * 文件元信息（行数 / 字节数），**不返回内容**。
   *
   * 给"要不要读、读多少"做判断用：子助手结论落盘后，父模型只需要知道这份报告有多大，
   * 需要正文再用 `read-file` 分页读 —— 摘要本身也占 token，不该再复制一份。
   */
  async statFile(
    ctx: FileContext,
    filePath: string,
  ): Promise<{ path: string; bytes: number; lines: number } | null> {
    const target = await resolveWorkspacePath({
      caps: this.caps,
      conversationId: ctx.conversationId,
      path: filePath,
      allowMissing: true,
    }).catch(() => null)
    if (!target) return null
    const info = await this.statOf(ctx, target)
    if (!info?.isFile()) return null
    const body = await this.readBytesOf(ctx, target).catch(() => null)
    if (!body) return null
    let lines = 0
    for (const byte of body) if (byte === 0x0a) lines += 1
    // 末尾没有换行时最后一截也算一行
    if (body.length > 0 && body[body.length - 1] !== 0x0a) lines += 1
    return { path: filePath, bytes: info.size, lines }
  }

  /** `write-file`：整文件写入 / 覆盖（原子） */
  async writeFile(
    ctx: FileContext,
    input: WriteFileInput,
  ): Promise<{ path: string; bytes: number; lines: number; created: boolean }> {
    const config = this.configOf(ctx)
    const target = await resolveWorkspacePath({
      caps: this.caps,
      conversationId: ctx.conversationId,
      path: input.filePath,
      allowMissing: true,
    })
    this.assertNotCache(ctx, target)
    const body = Buffer.from(input.content, 'utf8')
    if (body.includes(0)) throw new FileDeniedError('invalid-input', '写入内容包含二进制 NUL')
    if (body.length > config.maxWriteBytes) {
      throw new FileDeniedError('invalid-input', `单次写入超过 ${config.maxWriteBytes} 字节`)
    }
    if (body.length > config.maxBytes) {
      throw new FileDeniedError('invalid-input', `文件超过单文件上限 ${config.maxBytes} 字节`)
    }
    return this.locks.run(`${ctx.conversationId}:${target}`, async () => {
      const existing = await this.statOf(ctx, target)
      if (existing?.isDirectory()) throw new FileDeniedError('invalid-input', '目标是目录')
      const created = !existing
      await this.writeTextOf(ctx, target, body.toString('utf8'))
      return { path: target, bytes: body.length, lines: lineCount(input.content), created }
    })
  }

  /** `replace-file`：精确字符串替换（默认唯一匹配） */
  async replaceFile(
    ctx: FileContext,
    input: ReplaceFileInput,
  ): Promise<{ path: string; replaced: number; bytes: number; lines: number }> {
    const config = this.configOf(ctx)
    const target = await resolveWorkspacePath({
      caps: this.caps,
      conversationId: ctx.conversationId,
      path: input.filePath,
    })
    this.assertNotCache(ctx, target)
    const info = await this.statOf(ctx, target)
    if (!info?.isFile()) throw new FileDeniedError('invalid-input', '不是普通文件')
    if (info.size > config.readMaxBytes) {
      throw new FileDeniedError('invalid-input', `文件超过读取上限 ${config.readMaxBytes} 字节`)
    }
    if (!isTextFile(target)) throw new FileDeniedError('invalid-input', '只处理文本文件')

    return this.locks.run(`${ctx.conversationId}:${target}`, async () => {
      const before = await this.readTextOf(ctx, target)
      const occurrences = before.split(input.oldText).length - 1
      if (occurrences === 0) {
        throw new FileDeniedError('invalid-input', '没有找到要替换的内容（oldText 必须精确匹配）')
      }
      if (occurrences > 1 && input.all !== true) {
        throw new FileDeniedError(
          'invalid-input',
          `oldText 匹配到 ${occurrences} 处；提供更长的唯一上下文，或 all=true`,
        )
      }
      const after =
        input.all === true
          ? before.split(input.oldText).join(input.newText)
          : before.replace(input.oldText, () => input.newText)
      const body = Buffer.from(after, 'utf8')
      if (body.length > config.maxWriteBytes) {
        throw new FileDeniedError(
          'invalid-input',
          `替换后超过单次写入上限 ${config.maxWriteBytes} 字节`,
        )
      }
      if (body.length > config.maxBytes) {
        throw new FileDeniedError('invalid-input', `替换后超过单文件上限 ${config.maxBytes} 字节`)
      }
      await this.writeTextOf(ctx, target, after)
      return {
        path: target,
        replaced: input.all === true ? occurrences : 1,
        bytes: body.length,
        lines: lineCount(after),
      }
    })
  }

  /** `append-file`：末尾追加 */
  async appendFile(
    ctx: FileContext,
    input: AppendFileInput,
  ): Promise<{ path: string; bytes: number; lines: number; created: boolean }> {
    const config = this.configOf(ctx)
    const target = await resolveWorkspacePath({
      caps: this.caps,
      conversationId: ctx.conversationId,
      path: input.filePath,
      allowMissing: true,
    })
    this.assertNotCache(ctx, target)
    const content = Buffer.from(input.content, 'utf8')
    if (content.includes(0)) throw new FileDeniedError('invalid-input', '写入内容包含二进制 NUL')

    return this.locks.run(`${ctx.conversationId}:${target}`, async () => {
      const existing = await this.statOf(ctx, target)
      if (existing?.isDirectory()) throw new FileDeniedError('invalid-input', '目标是目录')
      if (existing && existing.size + content.length > config.maxBytes) {
        throw new FileDeniedError('invalid-input', `追加后超过单文件上限 ${config.maxBytes} 字节`)
      }
      if (content.length > config.maxWriteBytes) {
        throw new FileDeniedError('invalid-input', `单次追加超过 ${config.maxWriteBytes} 字节`)
      }
      await this.appendTextOf(ctx, target, input.content)
      const after = await this.readTextOf(ctx, target)
      return {
        path: target,
        bytes: Buffer.byteLength(after, 'utf8'),
        lines: lineCount(after),
        created: !existing,
      }
    })
  }

  /**
   * 工作区文件 → 临时 OSS 对象 → 预签名链接。
   *
   * 前端直接 fetch 这个 URL 拿文件流，不再让后端转发字节；工作区是本地盘，
   * 必须先物化成对象存储对象，才有「链接可给」。临时对象放在 `_preview/` 前缀，
   * 由桶生命周期清理（不在请求路径里删，避免预览中的链接失效）。
   */
  async workspaceLink(
    ctx: FileContext,
    input: { conversationId: string; path: string; download?: boolean },
  ): Promise<{ url: string; mediaType: string; filename: string; bytes: number }> {
    const config = this.configOf(ctx)
    const target = await resolveWorkspacePath({
      caps: this.caps,
      conversationId: input.conversationId,
      path: input.path,
    })
    const info = await this.statOf(ctx, target)
    if (!info?.isFile()) throw new FileDeniedError('invalid-input', '不是普通文件')
    if (info.size > config.maxBytes) {
      throw new FileDeniedError('invalid-input', '文件超过单文件上限')
    }

    const body = await this.readBytesOf(ctx, target)
    const digest = sha256(body)
    const extension = extensionOf(input.path)
    const owner = ctx.isAdmin ? 'admin' : ctx.userId ? `user/${ctx.userId}` : 'system'
    // 用内容哈希做 key：同一工作区文件重复预览不会堆出无限临时对象
    const key = `${PREVIEW_PREFIX}${owner}/${input.conversationId}/${digest}${extension ? `.${extension}` : ''}`
    const mediaType = mediaTypeOf(target)
    const filename = displayName(input.path)
    await this.storage.putObject({ key, body, contentType: mediaType })
    // 图片 / PDF / 视频要 inline 才不会被浏览器当附件下载；只有下载入口才带 filename
    const { url } = await this.storage.getDownloadUrl({
      key,
      ...(input.download ? { filename } : {}),
    })
    return { url, mediaType, filename, bytes: body.length }
  }

  /** 管理员预览：按文件 id 读任意会话的文本（不要求会话归属） */
  /** 管理员预览：按文件 id 读任意会话的文本（不要求会话归属） */
  async adminPreview(
    fileId: string,
  ): Promise<{ text: string; mediaType: string; truncated: boolean }> {
    const row = await this.files.findById(fileId)
    if (!row) throw new FileDeniedError('forbidden', '文件不存在')
    if (!isTextFile(row.filename, row.mediaType)) {
      throw new FileDeniedError('invalid-input', '这个文件不是文本类型')
    }
    const limit = 1024 * 1024
    const object = await this.storage.getObject({ key: row.key })
    return {
      text: object.body.subarray(0, limit).toString('utf8'),
      mediaType: row.mediaType,
      truncated: object.body.length > limit,
    }
  }

  /** 文本预览（会话文件 / 工作区）：只返回文本，不返回二进制 */
  async previewText(
    ctx: FileContext,
    path: string,
    source: 'ai' | 'workspace' = 'ai',
  ): Promise<{ text: string; mediaType: string; truncated: boolean }> {
    const limit = 1024 * 1024
    if (source === 'ai') {
      const row = await this.files.find(ctx.conversationId, path)
      if (!row) throw new FileDeniedError('forbidden', '本会话没有这个文件')
      if (!isTextFile(row.filename, row.mediaType)) {
        throw new FileDeniedError('invalid-input', '这个文件不是文本类型')
      }
      const object = await this.storage.getObject({ key: row.key })
      return {
        text: object.body.subarray(0, limit).toString('utf8'),
        mediaType: row.mediaType,
        truncated: object.body.length > limit,
      }
    }
    const target = await resolveWorkspacePath({
      caps: this.caps,
      conversationId: ctx.conversationId,
      path,
    })
    const info = await this.statOf(ctx, target)
    if (!info?.isFile()) throw new FileDeniedError('invalid-input', '不是普通文件')
    if (!isTextFile(target)) throw new FileDeniedError('invalid-input', '这个文件不是文本类型')
    const body = await this.readBytesOf(ctx, target)
    return {
      text: body.subarray(0, limit).toString('utf8'),
      mediaType: mediaTypeOf(target),
      truncated: body.length > limit,
    }
  }

  /** 工作区内容流：给 `<img>` / `<video>` / `<iframe>` / 下载用 */
  async workspaceContent(
    ctx: FileContext,
    path: string,
    download = false,
  ): Promise<{ path: string; size: number; mediaType: string; inline: boolean; body?: Buffer }> {
    const target = await resolveWorkspacePath({
      caps: this.caps,
      conversationId: ctx.conversationId,
      path,
    })
    const info = await this.statOf(ctx, target)
    if (!info?.isFile()) throw new FileDeniedError('invalid-input', '不是普通文件')
    if (info.size > this.configOf(ctx).maxBytes) {
      throw new FileDeniedError(
        'invalid-input',
        `文件超过单文件上限 ${this.configOf(ctx).maxBytes} 字节`,
      )
    }
    const mediaType = mediaTypeOf(target)
    const ext = target.split('.').pop()?.toLowerCase() ?? ''
    const inline =
      !download &&
      ext !== 'html' &&
      ext !== 'htm' &&
      ext !== 'svg' &&
      (mediaType.startsWith('image/') ||
        mediaType.startsWith('video/') ||
        mediaType.startsWith('audio/') ||
        mediaType === 'application/pdf')
    if (this.fsPort && ctx.workspaceId) {
      const body = await this.readBytesOf(ctx, target)
      return { path: target, size: body.length, mediaType, inline, body }
    }
    return { path: target, size: info.size, mediaType, inline }
  }

  /**
   * 入站附件登记：`source='user'`，引用前端预签名上传后的 key，不复制字节。
   *
   * 不按配额拒绝：附件已经传上来了，登记失败只会让文件树少一行；
   * 硬拒这一轮会让用户莫名其妙。
   */
  async registerInbound(
    ctx: FileContext,
    attachments: readonly ChatAttachmentModel[],
  ): Promise<void> {
    for (const attachment of attachments) {
      const basename = attachment.key.split('/').pop() ?? ''
      if (!basename) continue
      const path = `uploads/${basename}`
      try {
        await this.files.upsert({
          conversationId: ctx.conversationId,
          source: 'user',
          path,
          filename: attachment.filename,
          key: attachment.key,
          mediaType: attachment.mediaType,
          bytes: attachment.bytes,
          sha256: null,
          userId: ctx.userId,
          runId: ctx.runId,
          toolCallId: null,
        })
      } catch (error) {
        this.logger.warn('ai.file.register_failed', {
          conversationId: ctx.conversationId,
          key: attachment.key,
          reason: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }

  /**
   * 入站附件物化：对象存储 → `{workspace}/uploads/{md5}{ext}`。
   *
   * 失败只记日志：附件仍会喂给模型，文件树 / `file-download` 可以后续补。
   */
  async materializeInbound(
    ctx: FileContext,
    attachments: readonly ChatAttachmentModel[],
  ): Promise<void> {
    for (const attachment of attachments) {
      const basename = attachment.key.split('/').pop() ?? ''
      if (!basename) continue
      const target = await resolveWorkspacePath({
        caps: this.caps,
        conversationId: ctx.conversationId,
        path: `uploads/${basename}`,
        allowMissing: true,
      }).catch(() => null)
      if (!target) continue
      try {
        const existing = await this.statOf(ctx, target)
        if (existing?.isFile() && existing.size === attachment.bytes) continue
        const object = await this.storage.getObject({ key: attachment.key })
        await this.writeBytesOf(ctx, target, object.body)
      } catch (error) {
        this.logger.warn('ai.file.materialize_failed', {
          conversationId: ctx.conversationId,
          key: attachment.key,
          reason: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }

  /** 会话删除：删工作区；AI 对象删除；入站对象保留（内容寻址共享） */
  async cleanupConversation(conversationId: string): Promise<void> {
    const rows = await this.files.listAllWithDeleted(conversationId)
    for (const row of rows) {
      if (row.source !== 'ai') continue
      await this.storage.removeObject({ key: row.key }).catch((error: unknown) => {
        this.logger.warn('ai.file.remove_failed', {
          conversationId,
          key: row.key,
          reason: error instanceof Error ? error.message : String(error),
        })
      })
    }
    await this.files.softDeleteByConversation(conversationId)
    await rm(conversationWorkspace(this.caps, conversationId), {
      recursive: true,
      force: true,
    }).catch((error: unknown) => {
      this.logger.warn('ai.file.workspace_remove_failed', {
        conversationId,
        reason: error instanceof Error ? error.message : String(error),
      })
    })
  }

  /** 服务端对象 key：用户 / 管理员 / 无身份三种前缀 */
  private objectKey(ctx: FileContext, fileKey: string): string {
    const owner = ctx.isAdmin ? 'admin' : ctx.userId ? `user/${ctx.userId}` : 'system'
    return `${owner}/${ctx.conversationId}/${fileKey}`
  }

  /** `files/` 是下载缓存，编辑会被下一次下载覆盖；直接拒绝，逼模型先复制 */
  private assertNotCache(ctx: FileContext, target: string): void {
    const rel = relPath(this.workspaceOf(ctx), target)
    if (rel === 'files' || rel.startsWith('files/')) {
      throw new FileDeniedError(
        'invalid-input',
        'files/ 是下载缓存，编辑会被重新下载覆盖；先复制到其他工作区路径再改',
      )
    }
  }

  private async atomicWrite(target: string, body: Buffer): Promise<void> {
    const temp = `${target}.${process.pid}.${Date.now()}.tmp`
    await writeFile(temp, body, { mode: 0o600 })
    await rename(temp, target)
  }
}
