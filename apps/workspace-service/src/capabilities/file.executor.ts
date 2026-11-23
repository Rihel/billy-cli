import dedent from 'dedent'
import { posix } from 'node:path'
import { Inject, Injectable } from '@nestjs/common'
import {
  AppendFileInputSchema,
  ListInputSchema,
  ReadFileInputSchema,
  ReplaceFileInputSchema,
  WriteFileInputSchema,
  WorkspaceFilesInputSchema,
  FileSearchInputSchema,
} from '@repo/ai-data'
import { CapabilityDecl, CapabilityGroup, findCapabilityDecl } from '@repo/capability'
import type { ToolInvokeRequest, ToolOutcome } from '@repo/contracts'
import { WorkspaceRuntime } from '../workspace/workspace-runtime.service.js'
import { WorkspaceLocator } from './workspace.locator.js'

type FsOp = 'list' | 'read' | 'write' | 'append' | 'search'

/**
 * 文件能力（执行位置 = 工作区）：只做 fs 原语，OSS 语义（file-submit / file-download）仍在平台侧。
 *
 * v1 的返回是执行面的原始结果（分页 / 噪音目录过滤等业务后续再补）。
 */
@Injectable()
@CapabilityGroup({ risk: 'read' })
export class FileExecutor {
  constructor(
    @Inject(WorkspaceRuntime) private readonly runtime: WorkspaceRuntime,
    @Inject(WorkspaceLocator) private readonly locator: WorkspaceLocator,
  ) {}

  private async resolved(
    request: ToolInvokeRequest,
  ): Promise<{ workspaceId: string; workdir: string | null } | null> {
    const conversationId = request.workspaceConversationId ?? request.caller.conversationId
    const found = await this.locator.resolve(conversationId)
    if (!found) return null
    return request.workspaceId
      ? { workspaceId: request.workspaceId, workdir: found.workdir }
      : found
  }

  private async ensure(
    runtime: WorkspaceRuntime,
    workspaceId: string,
    workdir: string | null,
  ): Promise<ToolOutcome | null> {
    if (!workdir) return null
    const result = await runtime.fs(workspaceId, { workspaceId, op: 'mkdir', path: workdir })
    return result.ok
      ? null
      : {
          ok: false,
          reason: result.reason ?? 'exec-failed',
          message: result.message ?? '会话目录创建失败',
          retryable: false,
        }
  }

  private async run(
    tool: string,
    request: ToolInvokeRequest,
    op: FsOp,
    path: string,
    extra: Record<string, unknown> = {},
  ): Promise<ToolOutcome> {
    const parsed = findCapabilityDecl(this, tool).input.safeParse(request.input)
    if (!parsed.success) {
      return {
        ok: false,
        reason: 'invalid-input',
        message: `文件参数不合法：${parsed.error.issues[0]?.message ?? '未知错误'}`,
        retryable: false,
      }
    }
    const resolved = await this.resolved(request)
    if (!resolved) {
      return {
        ok: false,
        reason: 'no-workspace',
        message: '会话还没有绑定工作区',
        retryable: false,
      }
    }
    const ensured = await this.ensure(this.runtime, resolved.workspaceId, resolved.workdir)
    if (ensured) return ensured
    const result = await this.runtime.fs(resolved.workspaceId, {
      workspaceId: resolved.workspaceId,
      op,
      path: resolved.workdir ? posix.join(resolved.workdir, path === '.' ? '' : path) : path,
      ...extra,
    })
    return result.ok
      ? { ok: true, data: result.data }
      : {
          ok: false,
          reason: result.reason ?? 'exec-failed',
          message: result.message ?? '文件操作失败',
          retryable: false,
        }
  }

  @CapabilityDecl({
    tool: 'file-list',
    title: '列出会话文件',
    description: dedent`
      列出本会话的文件（用户上传 + AI 生成），按更新时间倒序返回元数据；不返回文件内容。
      不确定有哪些文件、或忘了 fileKey 时用。只看 workspace 里的文件用 workspace-files。
    `,
    input: ListInputSchema,
    execution: { mode: 'sync', where: 'workspace' },
  })
  fileList(request: ToolInvokeRequest): Promise<ToolOutcome> {
    return this.run('file-list', request, 'list', '.')
  }

  @CapabilityDecl({
    tool: 'read-file',
    title: '分页读取会话目录文件',
    description: dedent`
      分页读会话目录里的文本文件；默认 200 行 / 16KB，offset 是 1-based 行号，返回 totalLines / hasMore / nextOffset。
      大文件不要一次读完：先用 file-search 在整个会话目录定位行号，再用 offset 读那一段。
      只读文本；二进制用 bash / python。路径必须在本会话目录内。
    `,
    input: ReadFileInputSchema,
    execution: { mode: 'sync', where: 'workspace' },
  })
  readFile(request: ToolInvokeRequest): Promise<ToolOutcome> {
    const input = request.input as { filePath: string }
    return this.run('read-file', request, 'read', input.filePath)
  }

  @CapabilityDecl({
    tool: 'write-file',
    title: '写入会话目录文件',
    description: dedent`
      把完整内容写入会话目录文件（整文件覆盖）；父目录自动创建。
      局部改用 replace-file，末尾追加用 append-file。只写文本；单次内容上限 10MB（超大内容分段写 / 追加）。
      路径必须在本会话目录内；不要写 tmp/ 里正在下载的缓存。
    `,
    risk: 'write',
    input: WriteFileInputSchema,
    execution: { mode: 'sync', where: 'workspace' },
  })
  writeFile(request: ToolInvokeRequest): Promise<ToolOutcome> {
    const input = request.input as { filePath: string; content: string }
    return this.run('write-file', request, 'write', input.filePath, { content: input.content })
  }

  @CapabilityDecl({
    tool: 'append-file',
    title: '追加会话目录文件内容',
    description: dedent`
      把内容追加到会话目录文件末尾；文件不存在则创建。不会自动补换行。
      要改中间用 replace-file，要整文件覆盖用 write-file。
      只写文本；追加后不能超过单文件上限；路径必须在本会话目录内。
    `,
    risk: 'write',
    input: AppendFileInputSchema,
    execution: { mode: 'sync', where: 'workspace' },
  })
  appendFile(request: ToolInvokeRequest): Promise<ToolOutcome> {
    const input = request.input as { filePath: string; content: string }
    return this.run('append-file', request, 'append', input.filePath, { content: input.content })
  }

  @CapabilityDecl({
    tool: 'replace-file',
    title: '替换会话目录文件内容',
    description: dedent`
      在会话目录文本文件里做精确字符串替换（不是正则）；默认要求 oldText 唯一匹配。
      大文件先用 file-search 定位，再拿更长的唯一片段替换。
      只改文本；单次内容上限 10MB；路径必须在本会话目录内。
    `,
    risk: 'write',
    input: ReplaceFileInputSchema,
    execution: { mode: 'sync', where: 'workspace' },
  })
  async replaceFile(request: ToolInvokeRequest): Promise<ToolOutcome> {
    const parsed = findCapabilityDecl(this, 'replace-file').input.safeParse(request.input)
    if (!parsed.success) {
      return {
        ok: false,
        reason: 'invalid-input',
        message: `文件参数不合法：${parsed.error.issues[0]?.message ?? '未知错误'}`,
        retryable: false,
      }
    }
    const input = parsed.data as { filePath: string; oldText: string; newText: string }
    const resolved = await this.resolved(request)
    if (!resolved) {
      return {
        ok: false,
        reason: 'no-workspace',
        message: '会话还没有绑定工作区',
        retryable: false,
      }
    }
    const ensured = await this.ensure(this.runtime, resolved.workspaceId, resolved.workdir)
    if (ensured) return ensured
    const targetPath = resolved.workdir
      ? posix.join(resolved.workdir, input.filePath)
      : input.filePath
    const read = await this.runtime.fs(resolved.workspaceId, {
      workspaceId: resolved.workspaceId,
      op: 'read',
      path: targetPath,
    })
    if (!read.ok) {
      return {
        ok: false,
        reason: read.reason ?? 'exec-failed',
        message: read.message ?? '读文件失败',
      }
    }
    const content = String((read.data as { content?: string }).content ?? '')
    if (!content.includes(input.oldText)) {
      return { ok: false, reason: 'invalid-input', message: '没有找到要替换的内容' }
    }
    const next = content.split(input.oldText).join(input.newText)
    const write = await this.runtime.fs(resolved.workspaceId, {
      workspaceId: resolved.workspaceId,
      op: 'write',
      path: targetPath,
      content: next,
    })
    return write.ok
      ? { ok: true, data: write.data }
      : { ok: false, reason: write.reason ?? 'exec-failed', message: write.message ?? '写文件失败' }
  }

  @CapabilityDecl({
    tool: 'workspace-files',
    title: '列出会话目录文件',
    description: dedent`
      列出会话目录里的文件，扁平列表（不是树）；默认不显示 files/ 老缓存与 uploads/ 入站副本。
      返回相对路径 / 大小 / mtime，可直接给 read-file / replace-file；要搜索内容用 file-search。
      只看会话文件（OSS）用 file-list。一页 500 条：hasMore=true 时带 offset 翻下一页。
      自动跳过 node_modules / .git 等依赖与构建目录。
    `,
    input: WorkspaceFilesInputSchema,
    execution: { mode: 'sync', where: 'workspace' },
  })
  workspaceFiles(request: ToolInvokeRequest): Promise<ToolOutcome> {
    const input = request.input as { pathPrefix?: string }
    return this.run('workspace-files', request, 'list', input.pathPrefix ?? '.')
  }

  @CapabilityDecl({
    tool: 'file-search',
    title: '搜索会话目录文件内容',
    description: dedent`
      在整个会话目录的文本文件里搜关键词；空格分隔多个关键词（同一行必须全部出现），返回文件路径 + 行号 + 行内容。
      大文件先搜后读：拿到行号后用 read-file 的 offset 读上下文。
      跳过二进制 / 软链 / 依赖目录；结果有上限。
    `,
    input: FileSearchInputSchema,
    execution: { mode: 'sync', where: 'workspace' },
  })
  fileSearch(request: ToolInvokeRequest): Promise<ToolOutcome> {
    const input = request.input as { query: string; pathPrefix?: string }
    return this.run('file-search', request, 'search', input.pathPrefix ?? '.', {
      query: input.query,
    })
  }
}
