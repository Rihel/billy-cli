import { Inject, Injectable } from '@nestjs/common'
import { z } from 'zod'
import { ObjectStorage } from '@repo/kits'
import { ToolDecl, ToolGroup } from '../core/tools/tool.decorator.js'
import { TOOL_KEYS } from '../core/tools/tool-keys.js'
import {
  ToolDeniedError,
  type ToolCallContext,
  type ToolEnvCaps,
} from '../core/tools/tools.types.js'
import { FileConfigSchema, normalizeFileConfig, type FileConfigValue } from './file.schemas.js'
import {
  APPEND_FILE_TOOL,
  FILE_DOWNLOAD_TOOL,
  FILE_LIST_TOOL,
  FILE_SEARCH_TOOL,
  FILE_SUBMIT_TOOL,
  READ_FILE_TOOL,
  REPLACE_FILE_TOOL,
  WORKSPACE_FILES_TOOL,
  WRITE_FILE_TOOL,
} from '@repo/tool-catalog'
import { FileService, type FileContext } from './file.service.js'

/**
 * **文件工具组**（设计 `docs/design/ai-file-manager.md` §6）。
 *
 * ⚠️ 这里是**本地 / embedded 执行体**：远程模式（`TOOL_GATEWAY_URL` + allowlist 命中）下，
 * `ToolGateway.invoke()` 会在插件链之前直接短路到 gateway → worker，本类方法不会执行。
 * 保留它是为了 `AGENT_RUNTIME=embedded` / 未配置 gateway 的单机模式。
 *
 * 九个工具分两组：
 * - 对象存储：`file-submit` / `file-download` / `file-list`；
 * - workspace：`read-file` / `file-search` / `workspace-files` / `write-file` / `replace-file` / `append-file`。
 *
 * 子 agent 也可以使用这组工具（工作区是共享的）：父 agent 负责给每个子助手分配不同文件，
 * 避免并发覆盖；工具本身不提供跨 run 的文件锁。
 */
@Injectable()
@ToolGroup({ category: 'core', scope: 'all' })
export class FileTools {
  constructor(
    @Inject(FileService) private readonly files: FileService,
    @Inject(ObjectStorage) private readonly storage: ObjectStorage,
  ) {}

  /** 工具执行体共享的上下文：caller + 这一轮生效的配置 */
  private context(ctx: ToolCallContext<FileConfigValue>): FileContext {
    if (!ctx.caller) {
      throw new ToolDeniedError('precheck-failed', '缺少会话上下文，无法操作文件')
    }
    return {
      // 子会话共享父会话工作区与文件元数据；根会话两者相同
      conversationId: ctx.caller.workspaceConversationId ?? ctx.caller.conversationId,
      userId: ctx.caller.userId,
      isAdmin: ctx.caller.isAdmin,
      runId: ctx.caller.runId,
      toolCallId: ctx.toolCallId,
      config: ctx.settings.config,
    }
  }

  /** 对象存储类工具的前置条件：未配置就直接说清楚（workspace 工具不依赖它） */
  checkStorage(): string | null {
    return this.storage.enabled ? null : '对象存储未配置，无法提交 / 下载文件；workspace 工具仍可用'
  }

  normalizeConfig(config: FileConfigValue, caps: ToolEnvCaps): FileConfigValue {
    return normalizeFileConfig(config, caps)
  }

  @ToolDecl({
    key: TOOL_KEYS.fileSubmit,
    title: FILE_SUBMIT_TOOL.title,
    params: FILE_SUBMIT_TOOL.params,
    config: FileConfigSchema,
    precheck: 'checkStorage',
    normalize: 'normalizeConfig',
    description: FILE_SUBMIT_TOOL.description,
  })
  async submit(
    input: z.infer<typeof FILE_SUBMIT_TOOL.params>,
    ctx: ToolCallContext<FileConfigValue>,
  ) {
    return this.files.submit(this.context(ctx), input)
  }

  @ToolDecl({
    key: TOOL_KEYS.fileDownload,
    title: FILE_DOWNLOAD_TOOL.title,
    params: FILE_DOWNLOAD_TOOL.params,
    config: FileConfigSchema,
    precheck: 'checkStorage',
    normalize: 'normalizeConfig',
    description: FILE_DOWNLOAD_TOOL.description,
  })
  async download(
    input: z.infer<typeof FILE_DOWNLOAD_TOOL.params>,
    ctx: ToolCallContext<FileConfigValue>,
  ) {
    return this.files.download(this.context(ctx), input)
  }

  @ToolDecl({
    key: TOOL_KEYS.fileList,
    title: FILE_LIST_TOOL.title,
    params: FILE_LIST_TOOL.params,
    config: FileConfigSchema,
    normalize: 'normalizeConfig',
    description: FILE_LIST_TOOL.description,
  })
  async list(_input: z.infer<typeof FILE_LIST_TOOL.params>, ctx: ToolCallContext<FileConfigValue>) {
    if (!ctx.caller) throw new ToolDeniedError('precheck-failed', '缺少会话上下文，无法列出文件')
    return this.files.list(ctx.caller.workspaceConversationId ?? ctx.caller.conversationId)
  }

  @ToolDecl({
    key: TOOL_KEYS.readFile,
    title: READ_FILE_TOOL.title,
    params: READ_FILE_TOOL.params,
    config: FileConfigSchema,
    normalize: 'normalizeConfig',
    description: READ_FILE_TOOL.description,
  })
  async read(input: z.infer<typeof READ_FILE_TOOL.params>, ctx: ToolCallContext<FileConfigValue>) {
    return this.files.readFile(this.context(ctx), input)
  }

  @ToolDecl({
    key: TOOL_KEYS.fileSearch,
    title: FILE_SEARCH_TOOL.title,
    params: FILE_SEARCH_TOOL.params,
    config: FileConfigSchema,
    normalize: 'normalizeConfig',
    description: FILE_SEARCH_TOOL.description,
  })
  async search(
    input: z.infer<typeof FILE_SEARCH_TOOL.params>,
    ctx: ToolCallContext<FileConfigValue>,
  ) {
    return this.files.search(this.context(ctx), input)
  }

  @ToolDecl({
    key: TOOL_KEYS.workspaceFiles,
    title: WORKSPACE_FILES_TOOL.title,
    params: WORKSPACE_FILES_TOOL.params,
    config: FileConfigSchema,
    normalize: 'normalizeConfig',
    description: WORKSPACE_FILES_TOOL.description,
  })
  async workspaceFiles(
    input: z.infer<typeof WORKSPACE_FILES_TOOL.params>,
    ctx: ToolCallContext<FileConfigValue>,
  ) {
    return this.files.workspaceFiles(this.context(ctx), input)
  }

  @ToolDecl({
    key: TOOL_KEYS.writeFile,
    title: WRITE_FILE_TOOL.title,
    params: WRITE_FILE_TOOL.params,
    config: FileConfigSchema,
    normalize: 'normalizeConfig',
    description: WRITE_FILE_TOOL.description,
  })
  async write(
    input: z.infer<typeof WRITE_FILE_TOOL.params>,
    ctx: ToolCallContext<FileConfigValue>,
  ) {
    return this.files.writeFile(this.context(ctx), input)
  }

  @ToolDecl({
    key: TOOL_KEYS.replaceFile,
    title: REPLACE_FILE_TOOL.title,
    params: REPLACE_FILE_TOOL.params,
    config: FileConfigSchema,
    normalize: 'normalizeConfig',
    description: REPLACE_FILE_TOOL.description,
  })
  async replace(
    input: z.infer<typeof REPLACE_FILE_TOOL.params>,
    ctx: ToolCallContext<FileConfigValue>,
  ) {
    return this.files.replaceFile(this.context(ctx), input)
  }

  @ToolDecl({
    key: TOOL_KEYS.appendFile,
    title: APPEND_FILE_TOOL.title,
    params: APPEND_FILE_TOOL.params,
    config: FileConfigSchema,
    normalize: 'normalizeConfig',
    description: APPEND_FILE_TOOL.description,
  })
  async append(
    input: z.infer<typeof APPEND_FILE_TOOL.params>,
    ctx: ToolCallContext<FileConfigValue>,
  ) {
    return this.files.appendFile(this.context(ctx), input)
  }
}
