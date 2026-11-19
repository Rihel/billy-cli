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

  private async workspaceId(request: ToolInvokeRequest): Promise<string | null> {
    return request.workspaceId ?? (await this.locator.workspaceIdOf(request.caller.conversationId))
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
    const workspaceId = await this.workspaceId(request)
    if (!workspaceId) {
      return {
        ok: false,
        reason: 'no-workspace',
        message: '会话还没有绑定工作区',
        retryable: false,
      }
    }
    const result = await this.runtime.fs(workspaceId, {
      workspaceId,
      op,
      path,
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
    title: '列文件',
    description: '列出工作区根目录的文件',
    input: ListInputSchema,
    execution: { mode: 'sync', where: 'workspace' },
  })
  fileList(request: ToolInvokeRequest): Promise<ToolOutcome> {
    return this.run('file-list', request, 'list', '.')
  }

  @CapabilityDecl({
    tool: 'read-file',
    title: '读文件',
    description: '读工作区里的文本文件',
    input: ReadFileInputSchema,
    execution: { mode: 'sync', where: 'workspace' },
  })
  readFile(request: ToolInvokeRequest): Promise<ToolOutcome> {
    const input = request.input as { filePath: string }
    return this.run('read-file', request, 'read', input.filePath)
  }

  @CapabilityDecl({
    tool: 'write-file',
    title: '写文件',
    description: '整文件覆盖写入',
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
    title: '追加文件',
    description: '把内容追加到文件末尾',
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
    title: '替换文件内容',
    description: '精确字符串替换',
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
    const workspaceId = await this.workspaceId(request)
    if (!workspaceId) {
      return {
        ok: false,
        reason: 'no-workspace',
        message: '会话还没有绑定工作区',
        retryable: false,
      }
    }
    const read = await this.runtime.fs(workspaceId, {
      workspaceId,
      op: 'read',
      path: input.filePath,
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
    const write = await this.runtime.fs(workspaceId, {
      workspaceId,
      op: 'write',
      path: input.filePath,
      content: next,
    })
    return write.ok
      ? { ok: true, data: write.data }
      : { ok: false, reason: write.reason ?? 'exec-failed', message: write.message ?? '写文件失败' }
  }

  @CapabilityDecl({
    tool: 'workspace-files',
    title: '工作区文件清单',
    description: '列出工作区里的文件',
    input: WorkspaceFilesInputSchema,
    execution: { mode: 'sync', where: 'workspace' },
  })
  workspaceFiles(request: ToolInvokeRequest): Promise<ToolOutcome> {
    const input = request.input as { pathPrefix?: string }
    return this.run('workspace-files', request, 'list', input.pathPrefix ?? '.')
  }

  @CapabilityDecl({
    tool: 'file-search',
    title: '搜索文件内容',
    description: '按关键词搜索工作区文本文件',
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
