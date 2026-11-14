import { Inject, Injectable } from '@nestjs/common'
import { AppLogger } from '@repo/kits'
import {
  FileConfigSchema,
  FileDeniedError,
  FILE_CAPS,
  FileService,
  normalizeFileConfig,
  type FileContext,
  type FileCaps,
  type FileConfigValue,
} from '@repo/ai-data'
import {
  APPEND_FILE_TOOL,
  getToolDefinition,
  FILE_DOWNLOAD_TOOL,
  FILE_LIST_TOOL,
  FILE_SEARCH_TOOL,
  FILE_SUBMIT_TOOL,
  READ_FILE_TOOL,
  REPLACE_FILE_TOOL,
  WORKSPACE_FILES_TOOL,
  WRITE_FILE_TOOL,
} from '@repo/tool-catalog'
import type { ToolInvokeRequest, ToolOutcome } from '@repo/contracts'

export const FILE_TOOL_KEYS: readonly string[] = [
  FILE_SUBMIT_TOOL.key,
  FILE_DOWNLOAD_TOOL.key,
  FILE_LIST_TOOL.key,
  READ_FILE_TOOL.key,
  FILE_SEARCH_TOOL.key,
  WORKSPACE_FILES_TOOL.key,
  WRITE_FILE_TOOL.key,
  REPLACE_FILE_TOOL.key,
  APPEND_FILE_TOOL.key,
]

/** file-* 执行器：worker 直连 PG + OSS，workspace 用 worker 本地临时目录 */
@Injectable()
export class FileExecutor {
  readonly keys = FILE_TOOL_KEYS

  constructor(
    @Inject(FileService) private readonly files: FileService,
    @Inject(FILE_CAPS) private readonly caps: FileCaps,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}

  async execute(toolKey: string, request: ToolInvokeRequest): Promise<ToolOutcome> {
    if (!request.caller.userId) {
      return { ok: false, reason: 'forbidden', message: '没有用户身份，不能操作文件' }
    }
    const definition = getToolDefinition(toolKey)
    if (!definition) {
      return { ok: false, reason: 'unknown-tool', message: `未知工具：${toolKey}` }
    }
    const parsed = definition.params.safeParse(request.input)
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
      switch (toolKey) {
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
        toolKey,
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
