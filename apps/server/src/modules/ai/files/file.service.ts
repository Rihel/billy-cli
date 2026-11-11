import { createHash } from 'node:crypto'
import { appendFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import { Inject, Injectable, Optional } from '@nestjs/common'
import { AppLogger, ObjectStorage } from '@repo/kits'
import {
  buildFileTree,
  type AgentFileAdminListDto,
  type AgentFileAdminListModel,
  type AgentFileAdminQueryDto,
  type AgentFileAdminStatsModel,
  type AgentFileBinaryDto,
  type AgentFileBinaryModel,
  type AgentFileModel,
  type AgentFileNode,
  type ChatAttachmentModel,
} from '@repo/shared'
import { TOOL_ENV_CAPS } from '../core/tools/tool.config.ports.js'
import { ToolDeniedError } from '../core/tools/tools.types.js'
import type { ToolEnvCaps } from '../core/tools/tools.types.js'
import {
  conversationWorkspace,
  displayName,
  isTextFile,
  mediaTypeOf,
  normalizeFileKey,
  resolveWorkspacePath,
} from '../core/tools/workspace.js'
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

const IGNORED_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  '.next',
  '__pycache__',
  '.venv',
])

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
export class FileService {
  private readonly locks = new PathLock()

  constructor(
    @Inject(ObjectStorage) private readonly storage: ObjectStorage,
    @Inject(FileRepository) private readonly files: FileRepository,
    @Inject(AppLogger) private readonly logger: AppLogger,
    @Optional() @Inject(TOOL_ENV_CAPS) private readonly caps?: ToolEnvCaps,
  ) {}

  private configOf(ctx: FileContext): FileConfigValue {
    return ctx.config ?? normalizeFileConfig(DEFAULT_FILE_CONFIG, this.caps)
  }

  private workspaceOf(ctx: FileContext): string {
    return conversationWorkspace(this.caps, ctx.conversationId)
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
    const info = await stat(filePath).catch(() => null)
    if (!info?.isFile()) {
      throw new ToolDeniedError('invalid-input', `不是普通文件：${input.filePath}`)
    }
    if (info.size <= 0) throw new ToolDeniedError('invalid-input', '不能提交空文件')
    if (info.size > config.maxBytes) {
      throw new ToolDeniedError(
        'invalid-input',
        `文件超过单文件上限 ${Math.round(config.maxBytes / 1024 / 1024)}MB`,
      )
    }
    if (isSensitiveName(filePath)) {
      throw new ToolDeniedError('invalid-input', '该文件看起来是密钥 / 凭据，不允许提交')
    }

    const fileKey = normalizeFileKey(input.fileKey)
    if (fileKey === 'uploads' || fileKey.startsWith('uploads/')) {
      throw new ToolDeniedError('invalid-input', 'fileKey 不能以 uploads/ 开头（保留给用户上传）')
    }

    return this.locks.run(`${ctx.conversationId}:${fileKey}`, async () => {
      const body = await readFile(filePath)
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
        throw new ToolDeniedError(
          'invalid-input',
          `本会话文件已达上限 ${config.maxFilesPerConversation} 个`,
        )
      }
      if (quota.bytes + body.length > config.maxTotalBytesPerConversation) {
        throw new ToolDeniedError(
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
    if (!row) throw new ToolDeniedError('forbidden', '本会话没有这个文件')
    if (row.bytes > config.readMaxBytes) {
      throw new ToolDeniedError('invalid-input', `文件超过读取上限 ${config.readMaxBytes} 字节`)
    }
    const source = row.source === 'user' ? ('user' as const) : ('ai' as const)
    const defaultPath = source === 'user' ? row.path : `files/${row.path}`
    const target = await resolveWorkspacePath({
      caps: this.caps,
      conversationId: ctx.conversationId,
      path: input.filePath ?? defaultPath,
      allowMissing: true,
    })
    const existing = await stat(target).catch(() => null)
    if (existing?.isFile()) {
      if (row.sha256) {
        const current = sha256(await readFile(target))
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
      throw new ToolDeniedError('upstream', '对象已损坏（sha256 不匹配），请重新提交', undefined, true)
    }
    await mkdir(dirname(target), { recursive: true })
    await this.atomicWrite(target, object.body)
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
    const info = await stat(target)
    if (!info.isFile()) throw new ToolDeniedError('invalid-input', '不是普通文件')
    if (info.size > config.readMaxBytes) {
      throw new ToolDeniedError('invalid-input', `文件超过读取上限 ${config.readMaxBytes} 字节`)
    }
    if (!isTextFile(target)) {
      throw new ToolDeniedError('invalid-input', 'read-file 只读文本文件；二进制用 bash / python')
    }

    const lines = (await readFile(target, 'utf8')).split('\n')
    const totalLines = lines.length
    const offset = Math.max(1, input.offset ?? 1)
    const limit = Math.min(input.limit ?? config.pageLines, 500)
    if (offset > totalLines) {
      return { path: target, totalLines, offset, limit, text: '', hasMore: false, nextOffset: offset, truncated: false }
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
    if (keywords.length === 0) throw new ToolDeniedError('invalid-input', 'keywords 不能为空')
    if (keywords.length > config.searchMaxKeywords) {
      throw new ToolDeniedError('invalid-input', `关键词最多 ${config.searchMaxKeywords} 个`)
    }
    if (keywords.some((word) => word.length > 50)) {
      throw new ToolDeniedError('invalid-input', '每个关键词最多 50 字符')
    }
    const needle = keywords.map((word) => (input.caseSensitive ? word : word.toLowerCase()))
    const maxResults = Math.min(input.maxResults ?? config.searchMaxResults, config.searchMaxResults)
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
      const content = await readFile(file, 'utf8').catch(() => null)
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
      const entries = await readdirSafe(dir)
      for (const entry of entries) {
        if (truncated) return
        if (entry.isSymbolicLink()) continue
        const full = resolve(dir, entry.name)
        if (entry.isDirectory()) {
          if (IGNORED_DIRS.has(entry.name)) continue
          await walk(full, depth + 1)
        } else if (entry.isFile()) {
          await scanFile(full)
        }
      }
    }

    const startInfo = await stat(start).catch(() => null)
    if (!startInfo) {
      if (!input.pathPrefix) return { items: [], totalMatches: 0, truncated: false, scannedFiles: 0 }
      throw new ToolDeniedError('invalid-input', `目录不存在：${input.pathPrefix}`)
    }
    if (startInfo.isDirectory()) await walk(start, 0)
    else await scanFile(start)

    return { items, totalMatches, truncated, scannedFiles }
  }

  /** `workspace-files`：工作区扁平清单 */
  async workspaceFiles(
    ctx: FileContext,
    input: WorkspaceFilesInput,
  ): Promise<{
    items: Array<{ path: string; bytes: number; mtime: string }>
    total: number
    truncated: boolean
  }> {
    const config = this.configOf(ctx)
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
    let truncated = false

    const walk = async (dir: string, depth: number): Promise<void> => {
      if (truncated || depth > config.workspaceMaxDepth) {
        truncated = truncated || depth > config.workspaceMaxDepth
        return
      }
      const entries = await readdirSafe(dir)
      for (const entry of entries) {
        if (truncated) return
        if (entry.isSymbolicLink()) continue
        const full = resolve(dir, entry.name)
        if (entry.isDirectory()) {
          if (IGNORED_DIRS.has(entry.name)) continue
          if (!includeCaches && depth === 0 && (entry.name === 'files' || entry.name === 'uploads')) {
            continue
          }
          await walk(full, depth + 1)
        } else if (entry.isFile()) {
          const info = await stat(full).catch(() => null)
          if (!info) continue
          if (items.length >= config.workspaceMaxFiles) {
            truncated = true
            return
          }
          items.push({
            path: relPath(root, full),
            bytes: info.size,
            mtime: info.mtime.toISOString(),
          })
        }
      }
    }

    const startInfo = await stat(start).catch(() => null)
    if (!startInfo) {
      if (!input.pathPrefix) return { items: [], total: 0, truncated: false }
      throw new ToolDeniedError('invalid-input', `目录不存在：${input.pathPrefix}`)
    }
    if (startInfo.isDirectory()) await walk(start, 0)
    else {
      const info = await stat(start)
      items.push({
        path: relPath(root, start),
        bytes: info.size,
        mtime: info.mtime.toISOString(),
      })
    }

    items.sort((left, right) => left.path.localeCompare(right.path, 'zh-Hans-CN'))
    return { items, total: items.length, truncated }
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
    if (body.includes(0)) throw new ToolDeniedError('invalid-input', '写入内容包含二进制 NUL')
    if (body.length > config.maxWriteBytes) {
      throw new ToolDeniedError('invalid-input', `单次写入超过 ${config.maxWriteBytes} 字节`)
    }
    if (body.length > config.maxBytes) {
      throw new ToolDeniedError('invalid-input', `文件超过单文件上限 ${config.maxBytes} 字节`)
    }
    return this.locks.run(`${ctx.conversationId}:${target}`, async () => {
      const existing = await stat(target).catch(() => null)
      if (existing?.isDirectory()) throw new ToolDeniedError('invalid-input', '目标是目录')
      const created = !existing
      await mkdir(dirname(target), { recursive: true })
      await this.atomicWrite(target, body)
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
    const info = await stat(target)
    if (!info.isFile()) throw new ToolDeniedError('invalid-input', '不是普通文件')
    if (info.size > config.readMaxBytes) {
      throw new ToolDeniedError('invalid-input', `文件超过读取上限 ${config.readMaxBytes} 字节`)
    }
    if (!isTextFile(target)) throw new ToolDeniedError('invalid-input', '只处理文本文件')

    return this.locks.run(`${ctx.conversationId}:${target}`, async () => {
      const before = await readFile(target, 'utf8')
      const occurrences = before.split(input.oldText).length - 1
      if (occurrences === 0) {
        throw new ToolDeniedError('invalid-input', '没有找到要替换的内容（oldText 必须精确匹配）')
      }
      if (occurrences > 1 && input.all !== true) {
        throw new ToolDeniedError(
          'invalid-input',
          `oldText 匹配到 ${occurrences} 处；提供更长的唯一上下文，或 all=true`,
        )
      }
      const after = input.all === true
        ? before.split(input.oldText).join(input.newText)
        : before.replace(input.oldText, () => input.newText)
      const body = Buffer.from(after, 'utf8')
      if (body.length > config.maxWriteBytes) {
        throw new ToolDeniedError('invalid-input', `替换后超过单次写入上限 ${config.maxWriteBytes} 字节`)
      }
      if (body.length > config.maxBytes) {
        throw new ToolDeniedError('invalid-input', `替换后超过单文件上限 ${config.maxBytes} 字节`)
      }
      await this.atomicWrite(target, body)
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
    if (content.includes(0)) throw new ToolDeniedError('invalid-input', '写入内容包含二进制 NUL')

    return this.locks.run(`${ctx.conversationId}:${target}`, async () => {
      const existing = await stat(target).catch(() => null)
      if (existing?.isDirectory()) throw new ToolDeniedError('invalid-input', '目标是目录')
      if (existing && existing.size + content.length > config.maxBytes) {
        throw new ToolDeniedError('invalid-input', `追加后超过单文件上限 ${config.maxBytes} 字节`)
      }
      if (content.length > config.maxWriteBytes) {
        throw new ToolDeniedError('invalid-input', `单次追加超过 ${config.maxWriteBytes} 字节`)
      }
      await mkdir(dirname(target), { recursive: true })
      await appendFile(target, content, { mode: 0o600 })
      const after = await readFile(target, 'utf8')
      return {
        path: target,
        bytes: Buffer.byteLength(after, 'utf8'),
        lines: lineCount(after),
        created: !existing,
      }
    })
  }

  /**
   * 读文件原始字节（base64）：前端 PPTX 等第三方渲染器需要 ArrayBuffer。
   *
   * 管理员可按 fileId 读任意会话；普通用户按 conversationId + path 读自己的。
   * 工作区文件从本地盘读，会话文件从对象存储读。
   */
  async binary(ctx: FileContext, input: AgentFileBinaryDto): Promise<AgentFileBinaryModel> {
    const config = this.configOf(ctx)

    if (input.fileId) {
      if (!ctx.isAdmin) throw new ToolDeniedError('forbidden', '只有管理员可以按 fileId 读取文件')
      const row = await this.files.findById(input.fileId)
      if (!row) throw new ToolDeniedError('forbidden', '文件不存在')
      if (row.bytes > config.maxBytes) {
        throw new ToolDeniedError('invalid-input', '文件超过单文件上限')
      }
      const object = await this.storage.getObject({ key: row.key })
      return {
        base64: object.body.toString('base64'),
        mediaType: row.mediaType,
        filename: row.filename,
        bytes: object.body.length,
      }
    }

    if (!input.conversationId || !input.path) {
      throw new ToolDeniedError('invalid-input', '缺少 conversationId + path')
    }
    if (input.source === 'workspace') {
      const target = await resolveWorkspacePath({
        caps: this.caps,
        conversationId: input.conversationId,
        path: input.path,
      })
      const info = await stat(target)
      if (!info.isFile()) throw new ToolDeniedError('invalid-input', '不是普通文件')
      if (info.size > config.maxBytes) {
        throw new ToolDeniedError('invalid-input', '文件超过单文件上限')
      }
      const body = await readFile(target)
      return {
        base64: body.toString('base64'),
        mediaType: mediaTypeOf(target),
        filename: displayName(input.path),
        bytes: body.length,
      }
    }

    const row = await this.files.find(input.conversationId, input.path)
    if (!row) throw new ToolDeniedError('forbidden', '本会话没有这个文件')
    if (row.bytes > config.maxBytes) {
      throw new ToolDeniedError('invalid-input', '文件超过单文件上限')
    }
    const object = await this.storage.getObject({ key: row.key })
    return {
      base64: object.body.toString('base64'),
      mediaType: row.mediaType,
      filename: row.filename,
      bytes: object.body.length,
    }
  }

  /** 管理员预览：按文件 id 读任意会话的文本（不要求会话归属） */
  async adminPreview(fileId: string): Promise<{ text: string; mediaType: string; truncated: boolean }> {
    const row = await this.files.findById(fileId)
    if (!row) throw new ToolDeniedError('forbidden', '文件不存在')
    if (!isTextFile(row.filename, row.mediaType)) {
      throw new ToolDeniedError('invalid-input', '这个文件不是文本类型')
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
      if (!row) throw new ToolDeniedError('forbidden', '本会话没有这个文件')
      if (!isTextFile(row.filename, row.mediaType)) {
        throw new ToolDeniedError('invalid-input', '这个文件不是文本类型')
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
    const info = await stat(target)
    if (!info.isFile()) throw new ToolDeniedError('invalid-input', '不是普通文件')
    if (!isTextFile(target)) throw new ToolDeniedError('invalid-input', '这个文件不是文本类型')
    const body = await readFile(target)
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
  ): Promise<{ path: string; size: number; mediaType: string; inline: boolean }> {
    const target = await resolveWorkspacePath({
      caps: this.caps,
      conversationId: ctx.conversationId,
      path,
    })
    const info = await stat(target)
    if (!info.isFile()) throw new ToolDeniedError('invalid-input', '不是普通文件')
    if (info.size > this.configOf(ctx).maxBytes) {
      throw new ToolDeniedError(
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
        const existing = await stat(target).catch(() => null)
        if (existing?.isFile() && existing.size === attachment.bytes) continue
        const object = await this.storage.getObject({ key: attachment.key })
        await mkdir(dirname(target), { recursive: true })
        await this.atomicWrite(target, object.body)
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
    const owner = ctx.isAdmin
      ? 'admin'
      : ctx.userId
        ? `user/${ctx.userId}`
        : 'system'
    return `${owner}/${ctx.conversationId}/${fileKey}`
  }

  /** `files/` 是下载缓存，编辑会被下一次下载覆盖；直接拒绝，逼模型先复制 */
  private assertNotCache(ctx: FileContext, target: string): void {
    const rel = relPath(this.workspaceOf(ctx), target)
    if (rel === 'files' || rel.startsWith('files/')) {
      throw new ToolDeniedError(
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

/** `readdir` 的统一兜底：目录读不到就当空（权限 / 被删），不炸整个工具 */
const readdirSafe = async (dir: string) => {
  const { readdir } = await import('node:fs/promises')
  return readdir(dir, { withFileTypes: true }).catch(() => [])
}
