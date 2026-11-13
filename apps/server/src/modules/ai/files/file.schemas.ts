import { z } from 'zod'
import type { ToolEnvCaps } from '../core/tools/tools.types.js'

/**
 * 文件管理的配置与工具入参（设计 `docs/design/ai-file-manager.md` §6.2）。
 *
 * 所有限额都有代码默认值；`normalizeFileConfig` 再把库里的值夹到 env 上限。
 * 工具侧把 `ctx.settings.config` 传进 `FileService`，HTTP 侧使用默认值。
 */
export const FileConfigSchema = z.object({
  enabled: z.boolean().default(true),
  maxBytes: z
    .number()
    .int()
    .positive()
    .default(5 * 1024 * 1024),
  maxFilesPerConversation: z.number().int().positive().default(200),
  maxTotalBytesPerConversation: z
    .number()
    .int()
    .positive()
    .default(100 * 1024 * 1024),
  readMaxBytes: z
    .number()
    .int()
    .positive()
    .default(5 * 1024 * 1024),
  pageLines: z.number().int().positive().default(200),
  maxPageChars: z
    .number()
    .int()
    .positive()
    .default(16 * 1024),
  maxWriteBytes: z
    .number()
    .int()
    .positive()
    .default(1024 * 1024),
  searchMaxFiles: z.number().int().positive().default(500),
  searchMaxBytes: z
    .number()
    .int()
    .positive()
    .default(20 * 1024 * 1024),
  searchMaxResults: z.number().int().positive().default(50),
  searchMaxLineChars: z.number().int().positive().default(500),
  searchMaxKeywords: z.number().int().positive().default(10),
  workspaceMaxFiles: z.number().int().positive().default(500),
  workspaceMaxDepth: z.number().int().positive().default(8),
})

export type FileConfigValue = z.infer<typeof FileConfigSchema>

export const DEFAULT_FILE_CONFIG: FileConfigValue = FileConfigSchema.parse({})

/** 部署上限（env）：只夹这几个会撑爆边界的旋钮 */
export interface FileEnvCaps {
  maxBytesMax?: number
  maxFilesMax?: number
  maxTotalBytesMax?: number
  readMaxBytesMax?: number
  pageLinesMax?: number
  pageCharsMax?: number
  writeBytesMax?: number
  searchFilesMax?: number
  searchBytesMax?: number
  searchResultsMax?: number
  workspaceFilesMax?: number
  workspaceDepthMax?: number
}

export const normalizeFileConfig = (
  config: FileConfigValue,
  caps?: ToolEnvCaps,
): FileConfigValue => {
  const file = (caps as (ToolEnvCaps & { file?: FileEnvCaps }) | undefined)?.file
  const min = (value: number, max?: number): number =>
    max === undefined ? value : Math.min(value, max)
  return {
    ...config,
    maxBytes: min(config.maxBytes, file?.maxBytesMax),
    maxFilesPerConversation: min(config.maxFilesPerConversation, file?.maxFilesMax),
    maxTotalBytesPerConversation: min(config.maxTotalBytesPerConversation, file?.maxTotalBytesMax),
    readMaxBytes: min(config.readMaxBytes, file?.readMaxBytesMax),
    pageLines: min(config.pageLines, file?.pageLinesMax),
    maxPageChars: min(config.maxPageChars, file?.pageCharsMax),
    maxWriteBytes: min(config.maxWriteBytes, file?.writeBytesMax),
    searchMaxFiles: min(config.searchMaxFiles, file?.searchFilesMax),
    searchMaxBytes: min(config.searchMaxBytes, file?.searchBytesMax),
    searchMaxResults: min(config.searchMaxResults, file?.searchResultsMax),
    workspaceMaxFiles: min(config.workspaceMaxFiles, file?.workspaceFilesMax),
    workspaceMaxDepth: min(config.workspaceMaxDepth, file?.workspaceDepthMax),
  }
}

/** `file-submit`：工作区文件 → 对象存储 */
export const SubmitInputSchema = z.object({
  filePath: z
    .string()
    .min(1)
    .max(1024)
    .describe('workspace 里要提交的文件路径（绝对或相对会话工作区）'),
  fileKey: z
    .string()
    .min(1)
    .max(255)
    .describe(
      '会话内逻辑路径，如 reports/2026/q1.pdf；不得以 uploads/ 开头；工具自动拼 userId 与会话 id',
    ),
})

/** `file-download`：对象存储 → 工作区 */
export const DownloadInputSchema = z.object({
  fileKey: z
    .string()
    .min(1)
    .max(255)
    .describe('本会话文件路径，从 file-list 拿；用户上传的是 uploads/{md5}{ext}'),
  filePath: z
    .string()
    .min(1)
    .max(1024)
    .optional()
    .describe('落盘位置（workspace 内绝对路径）；省略时入站放 uploads/...，AI 放 files/...'),
})

/** `file-list`：本会话文件清单 */
export const ListInputSchema = z.object({})

/** `read-file`：工作区文本分页 */
export const ReadFileInputSchema = z.object({
  filePath: z.string().min(1).max(1024).describe('workspace 内的文件路径（绝对或相对）'),
  offset: z.number().int().min(1).optional().describe('起始行（1-based）；默认 1'),
  limit: z.number().int().positive().max(500).optional().describe('这一页最多多少行；默认 200'),
})

/** `file-search`：整个工作区多关键词搜索 */
export const FileSearchInputSchema = z.object({
  keywords: z
    .string()
    .min(1)
    .max(200)
    .describe('空格分隔的多个关键词；同一行必须全部出现（AND）；最多 10 个'),
  caseSensitive: z.boolean().optional().describe('是否区分大小写；默认 false'),
  pathPrefix: z
    .string()
    .max(255)
    .optional()
    .describe('只搜这个子目录，如 uploads/ 或 notes/；省略 = 整个 workspace'),
  maxResults: z.number().int().positive().max(200).optional().describe('最多返回多少条；默认 50'),
})

/** `workspace-files`：工作区扁平清单 */
export const WorkspaceFilesInputSchema = z.object({
  pathPrefix: z
    .string()
    .max(255)
    .optional()
    .describe('只列这个子目录，如 uploads/ 或 notes/；省略 = 整个 workspace'),
  includeCaches: z
    .boolean()
    .optional()
    .describe('默认 false，隐藏 files/ 下载缓存与 uploads/ 入站副本'),
})

/** `write-file`：整文件写入 / 覆盖 */
export const WriteFileInputSchema = z.object({
  filePath: z.string().min(1).max(1024).describe('workspace 内目标路径；父目录自动创建'),
  content: z.string().max(1_000_000).describe('完整文件内容（UTF-8）；整文件覆盖'),
})

/** `replace-file`：精确字符串替换 */
export const ReplaceFileInputSchema = z.object({
  filePath: z.string().min(1).max(1024).describe('workspace 内目标文件路径'),
  oldText: z.string().min(1).max(10_000).describe('要替换的原文；必须精确匹配（含空白）'),
  newText: z.string().max(1_000_000).describe('替换后的内容；空串 = 删除这段'),
  all: z.boolean().optional().describe('默认 false；多处匹配时默认拒绝，要求更长的唯一上下文'),
})

/** `append-file`：末尾追加 */
export const AppendFileInputSchema = z.object({
  filePath: z.string().min(1).max(1024).describe('workspace 内目标文件路径；不存在则创建'),
  content: z.string().min(1).max(1_000_000).describe('追加内容（UTF-8）；不会自动加换行'),
})

/** 工作区列表 / 预览接口（HTTP） */
export const WorkspaceListSchema = z.object({
  conversationId: z.string().min(1).max(32),
  includeCaches: z.boolean().optional(),
})

export const WorkspacePreviewSchema = z.object({
  conversationId: z.string().min(1).max(32),
  path: z.string().min(1).max(1024),
  source: z.enum(['ai', 'workspace']).optional(),
})

/** 工作区内容流（GET，给 `<img>` / `<iframe>` 用） */
export const WorkspaceContentQuerySchema = z.object({
  conversationId: z.string().min(1).max(32),
  path: z.string().min(1).max(1024),
  download: z.enum(['0', '1']).optional(),
})
