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
import { FILE_SCHEMAS, FILE_TOOL_KEYS } from '../../capabilities/schemas.js'
import type { ToolInvokeRequest, ToolOutcome } from '@repo/contracts'

export { FILE_TOOL_KEYS }

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
    const schema = FILE_SCHEMAS[toolKey]
    if (!schema) {
      return { ok: false, reason: 'unknown-tool', message: `未知工具：${toolKey}` }
    }
    const parsed = schema.safeParse(request.input)
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
