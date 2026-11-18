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
  ) {}

  @CapabilityDecl({
    tool: 'file-list',
    title: '列文件',
    description: '列出会话工作区里的文件',
    input: ListInputSchema,
  })
  async fileList(request: ToolInvokeRequest): Promise<ToolOutcome> {
    return this.run('file-list', request)
  }

  @CapabilityDecl({
    tool: 'read-file',
    title: '读文件',
    description: '读工作区里的文本文件',
    input: ReadFileInputSchema,
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
  })
  async replaceFile(request: ToolInvokeRequest): Promise<ToolOutcome> {
    return this.run('replace-file', request)
  }

  @CapabilityDecl({
    tool: 'file-search',
    title: '搜文件内容',
    description: '按关键字搜索工作区文件内容',
    input: FileSearchInputSchema,
  })
  async fileSearch(request: ToolInvokeRequest): Promise<ToolOutcome> {
    return this.run('file-search', request)
  }

  @CapabilityDecl({
    tool: 'file-submit',
    title: '提交文件',
    description: '把文件提交到对象存储',
    risk: 'write',
    input: SubmitInputSchema,
  })
  async fileSubmit(request: ToolInvokeRequest): Promise<ToolOutcome> {
    return this.run('file-submit', request)
  }

  @CapabilityDecl({
    tool: 'file-download',
    title: '下载文件',
    description: '把对象存储里的文件拉到工作区',
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

    const ctx: FileContext = {
      conversationId: request.workspaceConversationId ?? request.caller.conversationId,
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
