import { Inject, Injectable } from '@nestjs/common'
import dedent from 'dedent'
import { z } from 'zod'
import { ObjectStorage } from '@repo/kits'
import { ToolDecl, ToolGroup } from '../core/tools/tool.decorator.js'
import { TOOL_KEYS } from '../core/tools/tool-keys.js'
import { ToolDeniedError, type ToolCallContext, type ToolEnvCaps } from '../core/tools/tools.types.js'
import {
  AppendFileInputSchema,
  DownloadInputSchema,
  FileConfigSchema,
  FileSearchInputSchema,
  ListInputSchema,
  ReadFileInputSchema,
  ReplaceFileInputSchema,
  SubmitInputSchema,
  WorkspaceFilesInputSchema,
  WriteFileInputSchema,
  normalizeFileConfig,
  type FileConfigValue,
} from './file.schemas.js'
import { FileService, type FileContext } from './file.service.js'

/**
 * **文件工具组**（设计 `docs/design/ai-file-manager.md` §6）。
 *
 * 九个工具分两组：
 * - 对象存储：`file-submit` / `file-download` / `file-list`；
 * - workspace：`read-file` / `file-search` / `workspace-files` / `write-file` / `replace-file` / `append-file`。
 *
 * 组级 `child: 'deny'`：子 agent 不做文件读写，父 agent 统一处理（工作区是共享的）。
 */
@Injectable()
@ToolGroup({ category: 'core', scope: 'all', child: 'deny' })
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
      conversationId: ctx.caller.conversationId,
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
    title: '提交文件到会话',
    params: SubmitInputSchema,
    config: FileConfigSchema,
    precheck: 'checkStorage',
    normalize: 'normalizeConfig',
    description: dedent`
      把 workspace 里的一个文件提交为**本会话的 AI 生成文件**（上传对象存储，用户可预览 / 下载）。
      用户上传的原文件已经自动进文件树，不要重复提交；修改后的新文件换一个 fileKey 再提交。
      filePath 传 workspace 路径，fileKey 传会话内路径（不得以 uploads/ 开头）；工具自动拼 userId 与会话 id。
      同一个 fileKey 再提交会覆盖旧版本。不要提交密钥、凭据或工作区之外的文件。
    `,
  })
  async submit(input: z.infer<typeof SubmitInputSchema>, ctx: ToolCallContext<FileConfigValue>) {
    return this.files.submit(this.context(ctx), input)
  }

  @ToolDecl({
    key: TOOL_KEYS.fileDownload,
    title: '下载会话文件到工作区',
    params: DownloadInputSchema,
    config: FileConfigSchema,
    precheck: 'checkStorage',
    normalize: 'normalizeConfig',
    description: dedent`
      把本会话的文件从对象存储**下载到 workspace**，返回本地路径；不返回内容。
      入站附件通常已经物化到 uploads/，会直接命中缓存；AI 文件下载到 files/。
      大文件下载后用 read-file 分页读；编辑用 write-file / replace-file / append-file，不要直接改 files/ 缓存。
    `,
  })
  async download(input: z.infer<typeof DownloadInputSchema>, ctx: ToolCallContext<FileConfigValue>) {
    return this.files.download(this.context(ctx), input)
  }

  @ToolDecl({
    key: TOOL_KEYS.fileList,
    title: '列出会话文件',
    params: ListInputSchema,
    config: FileConfigSchema,
    normalize: 'normalizeConfig',
    description: dedent`
      列出本会话的文件（用户上传 + AI 生成），按更新时间倒序返回元数据；不返回文件内容。
      不确定有哪些文件、或忘了 fileKey 时用。只看 workspace 里的文件用 workspace-files。
    `,
  })
  async list(_input: z.infer<typeof ListInputSchema>, ctx: ToolCallContext<FileConfigValue>) {
    if (!ctx.caller) throw new ToolDeniedError('precheck-failed', '缺少会话上下文，无法列出文件')
    return this.files.list(ctx.caller.conversationId)
  }

  @ToolDecl({
    key: TOOL_KEYS.readFile,
    title: '分页读取工作区文件',
    params: ReadFileInputSchema,
    config: FileConfigSchema,
    normalize: 'normalizeConfig',
    description: dedent`
      分页读 workspace 里的文本文件；默认 200 行 / 16KB，offset 是 1-based 行号，
      返回 totalLines / hasMore / nextOffset。
      大文件不要一次读完：先用 file-search 在整个工作区定位行号，再用 offset 读那一段。
      只读文本；二进制用 bash / python。路径必须在本会话 workspace 内。
    `,
  })
  async read(input: z.infer<typeof ReadFileInputSchema>, ctx: ToolCallContext<FileConfigValue>) {
    return this.files.readFile(this.context(ctx), input)
  }

  @ToolDecl({
    key: TOOL_KEYS.fileSearch,
    title: '搜索工作区文件内容',
    params: FileSearchInputSchema,
    config: FileConfigSchema,
    normalize: 'normalizeConfig',
    description: dedent`
      在整个 workspace 的文本文件里搜关键词；空格分隔多个关键词（同一行必须全部出现），
      返回文件路径 + 行号 + 行内容。大文件先搜后读：拿到行号后用 read-file 的 offset 读上下文。
      跳过二进制 / 软链 / 依赖目录；结果有上限。
    `,
  })
  async search(input: z.infer<typeof FileSearchInputSchema>, ctx: ToolCallContext<FileConfigValue>) {
    return this.files.search(this.context(ctx), input)
  }

  @ToolDecl({
    key: TOOL_KEYS.workspaceFiles,
    title: '列出工作区文件',
    params: WorkspaceFilesInputSchema,
    config: FileConfigSchema,
    normalize: 'normalizeConfig',
    description: dedent`
      列出 workspace 里的文件，**扁平列表**（不是树）；默认不显示 files/ 下载缓存与 uploads/ 入站副本。
      返回相对路径 / 大小 / mtime，可直接给 read-file / replace-file；要搜索内容用 file-search。
      只看会话文件（OSS）用 file-list。
    `,
  })
  async workspaceFiles(
    input: z.infer<typeof WorkspaceFilesInputSchema>,
    ctx: ToolCallContext<FileConfigValue>,
  ) {
    return this.files.workspaceFiles(this.context(ctx), input)
  }

  @ToolDecl({
    key: TOOL_KEYS.writeFile,
    title: '写入工作区文件',
    params: WriteFileInputSchema,
    config: FileConfigSchema,
    normalize: 'normalizeConfig',
    description: dedent`
      把完整内容写入 workspace 文件（整文件覆盖）；父目录自动创建。
      局部改用 replace-file，末尾追加用 append-file。只写文本；单次内容上限 1MB。
      路径必须在本会话 workspace 内；不要写 files/ 缓存（会被重新下载覆盖）。
    `,
  })
  async write(input: z.infer<typeof WriteFileInputSchema>, ctx: ToolCallContext<FileConfigValue>) {
    return this.files.writeFile(this.context(ctx), input)
  }

  @ToolDecl({
    key: TOOL_KEYS.replaceFile,
    title: '替换工作区文件内容',
    params: ReplaceFileInputSchema,
    config: FileConfigSchema,
    normalize: 'normalizeConfig',
    description: dedent`
      在 workspace 文本文件里做**精确字符串替换**（不是正则）；默认要求 oldText 唯一匹配。
      大文件先用 file-search 定位，再拿更长的唯一片段替换。
      只改文本；单次内容上限 1MB；路径必须在本会话 workspace 内。
    `,
  })
  async replace(input: z.infer<typeof ReplaceFileInputSchema>, ctx: ToolCallContext<FileConfigValue>) {
    return this.files.replaceFile(this.context(ctx), input)
  }

  @ToolDecl({
    key: TOOL_KEYS.appendFile,
    title: '追加工作区文件内容',
    params: AppendFileInputSchema,
    config: FileConfigSchema,
    normalize: 'normalizeConfig',
    description: dedent`
      把内容追加到 workspace 文件末尾；文件不存在则创建。不会自动补换行。
      要改中间用 replace-file，要整文件覆盖用 write-file。
      只写文本；追加后不能超过单文件上限；路径必须在本会话 workspace 内。
    `,
  })
  async append(input: z.infer<typeof AppendFileInputSchema>, ctx: ToolCallContext<FileConfigValue>) {
    return this.files.appendFile(this.context(ctx), input)
  }
}
