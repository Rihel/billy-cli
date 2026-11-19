import { Inject, Injectable } from '@nestjs/common'
import { AppLogger } from '@repo/kits'
import {
  AppendFileInputSchema,
  DownloadInputSchema,
  FileConfigSchema,
  FileDeniedError,
  FILE_CAPS,
  FileSearchInputSchema,
  FileService,
  ListInputSchema,
  normalizeFileConfig,
  ReadFileInputSchema,
  ReplaceFileInputSchema,
  SubmitInputSchema,
  WorkspaceFilesInputSchema,
  WriteFileInputSchema,
  type FileContext,
  type FileCaps,
  type FileConfigValue,
} from '@repo/ai-data'
import { CapabilityDecl, CapabilityGroup, findCapabilityDecl } from '@repo/capability'
import { WorkspaceLocator } from '../../executors/workspace.locator.js'
import type { ToolInvokeRequest, ToolOutcome } from '@repo/contracts'

/**
 * file-* 执行器：worker 直连 PG + OSS，workspace 用 worker 本地临时目录。
 *
 * 一个方法一个能力（声明 + 执行体同一处共用），校验与登记同一份 schema；
 * 文件域 schema 仍来自 `@repo/ai-data`（与 server 共享单一来源，内联会造第二份）。
 */
@Injectable()
@CapabilityGroup({ risk: 'read' })
export class FileExecutor {
  constructor(
    @Inject(FileService) private readonly files: FileService,
    @Inject(FILE_CAPS) private readonly caps: FileCaps,
    @Inject(AppLogger) private readonly logger: AppLogger,
    @Inject(WorkspaceLocator) private readonly locator: WorkspaceLocator,
  ) {}

  @CapabilityDecl({
    tool: 'file-list',
    title: '列文件',
    description: '列出会话工作区里的文件',
    input: ListInputSchema,
    execution: { where: 'workspace' },
  })
  async fileList(request: ToolInvokeRequest): Promise<ToolOutcome> {
    return this.run('file-list', request)
  }

  @CapabilityDecl({
    tool: 'read-file',
    title: '读文件',
    description: '读工作区里的文本文件',
    input: ReadFileInputSchema,
    execution: { where: 'workspace' },
  })
  async readFile(request: ToolInvokeRequest): Promise<ToolOutcome> {
    return this.run('read-file', request)
  }

  @CapabilityDecl({
    tool: 'write-file',
    title: '写文件',
    description: '整文件覆盖写入',
    risk: 'write',
    input: WriteFileInputSchema,
    execution: { where: 'workspace' },
  })
  async writeFile(request: ToolInvokeRequest): Promise<ToolOutcome> {
    return this.run('write-file', request)
  }

  @CapabilityDecl({
    tool: 'append-file',
    title: '追加文件',
    description: '把内容追加到文件末尾',
    risk: 'write',
    input: AppendFileInputSchema,
    execution: { where: 'workspace' },
  })
  async appendFile(request: ToolInvokeRequest): Promise<ToolOutcome> {
    return this.run('append-file', request)
  }

  @CapabilityDecl({
    tool: 'replace-file',
    title: '替换片段',
    description: '替换文件里的指定片段',
    risk: 'write',
    input: ReplaceFileInputSchema,
    execution: { where: 'workspace' },
  })
  async replaceFile(request: ToolInvokeRequest): Promise<ToolOutcome> {
    return this.run('replace-file', request)
  }

  @CapabilityDecl({
    tool: 'file-search',
    title: '搜文件内容',
    description: '按关键字搜索工作区文件内容',
    input: FileSearchInputSchema,
    execution: { where: 'workspace' },
  })
  async fileSearch(request: ToolInvokeRequest): Promise<ToolOutcome> {
    return this.run('file-search', request)
  }

  @CapabilityDecl({
    tool: 'file-submit',
    title: '提交文件到会话',
    description: [
      '把 workspace 里的一个文件提交为本会话的 AI 生成文件（上传对象存储，用户可预览 / 下载）。',
      '用户上传的原文件已经自动进文件树，不要重复提交；修改后的新文件换一个 fileKey 再提交。',
      'filePath 传 workspace 路径，fileKey 传会话内路径（不得以 uploads/ 开头）；工具自动拼 userId 与会话 id。',
      '同一个 fileKey 再提交会覆盖旧版本。不要提交密钥、凭据或工作区之外的文件。',
    ].join('\n'),
    risk: 'write',
    input: SubmitInputSchema,
  })
  async fileSubmit(request: ToolInvokeRequest): Promise<ToolOutcome> {
    return this.run('file-submit', request)
  }

  @CapabilityDecl({
    tool: 'file-download',
    title: '下载会话文件到工作区',
    description: [
      '把本会话的文件从对象存储下载到 workspace，返回本地路径；不返回内容。',
      '入站附件通常已经物化到 uploads/，会直接命中缓存；AI 文件下载到 files/。',
      '大文件下载后用 read-file 分页读；编辑用 write-file / replace-file / append-file，不要直接改 files/ 缓存。',
    ].join('\n'),
    risk: 'write',
    input: DownloadInputSchema,
  })
  async fileDownload(request: ToolInvokeRequest): Promise<ToolOutcome> {
    return this.run('file-download', request)
  }

  @CapabilityDecl({
    tool: 'workspace-files',
    title: '工作区清单',
    description: '列出对象存储里的工作区文件',
    input: WorkspaceFilesInputSchema,
    execution: { where: 'workspace' },
  })
  async workspaceFiles(request: ToolInvokeRequest): Promise<ToolOutcome> {
    return this.run('workspace-files', request)
  }

  /** 公共执行体：鉴权 → 按声明校验入参 → 分派到 FileService */
  private async run(tool: string, request: ToolInvokeRequest): Promise<ToolOutcome> {
    if (!request.caller.userId) {
      return { ok: false, reason: 'forbidden', message: '没有用户身份，不能操作文件' }
    }
    const parsed = findCapabilityDecl(this, tool).input.safeParse(request.input)
    if (!parsed.success) {
      return {
        ok: false,
        reason: 'invalid-input',
        message: `文件参数不合法：${parsed.error.issues[0]?.message ?? '未知错误'}`,
        retryable: false,
      }
    }

    const workspaceConversationId = request.workspaceConversationId ?? request.caller.conversationId
    const workspaceId = await this.locator.workspaceIdOf(workspaceConversationId).catch(() => null)
    const ctx: FileContext = {
      conversationId: workspaceConversationId,
      ...(workspaceId ? { workspaceId } : {}),
      userId: request.caller.userId,
      isAdmin: request.caller.isAdmin ?? false,
      runId: request.caller.runId,
      toolCallId: request.toolCallId,
      config: normalizeFileConfig(
        FileConfigSchema.parse(request.settings?.config ?? {}),
        this.caps,
      ) as FileConfigValue,
    }
    const input = parsed.data as never

    try {
      let data: unknown
      switch (tool) {
        case 'file-submit':
          data = await this.files.submit(ctx, input)
          break
        case 'file-download':
          data = await this.files.download(ctx, input)
          break
        case 'file-list':
          data = await this.files.list(ctx.conversationId)
          break
        case 'read-file':
          data = await this.files.readFile(ctx, input)
          break
        case 'file-search':
          data = await this.files.search(ctx, input)
          break
        case 'workspace-files':
          data = await this.files.workspaceFiles(ctx, input)
          break
        case 'write-file':
          data = await this.files.writeFile(ctx, input)
          break
        case 'replace-file':
          data = await this.files.replaceFile(ctx, input)
          break
        case 'append-file':
          data = await this.files.appendFile(ctx, input)
          break
      }
      return { ok: true, data }
    } catch (error) {
      if (error instanceof FileDeniedError) {
        return {
          ok: false,
          reason: error.reason,
          message: error.message,
          ...(error.hint ? { hint: error.hint } : {}),
          retryable: error.retryable,
        }
      }
      const reason = error instanceof Error ? error.message : String(error)
      this.logger.error('tool_worker.file_failed', {
        requestId: request.requestId,
        toolKey: tool,
        reason,
      })
      return {
        ok: false,
        reason: 'exec-failed',
        message: `文件操作失败：${reason}`,
        retryable: true,
      }
    }
  }
}
