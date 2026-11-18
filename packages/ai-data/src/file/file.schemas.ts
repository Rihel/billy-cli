import { z } from 'zod'
import type { FileCaps, FileEnvCaps } from './file.types.js'

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
    .default(10 * 1024 * 1024),
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
    .default(10 * 1024 * 1024),
  searchMaxFiles: z.number().int().positive().default(500),
  searchMaxBytes: z
    .number()
    .int()
    .positive()
    .default(20 * 1024 * 1024),
  searchMaxResults: z.number().int().positive().default(50),
  searchMaxLineChars: z.number().int().positive().default(500),
  searchMaxKeywords: z.number().int().positive().default(10),
  /** `workspace-files` 的**单页条数**（分页靠 offset 翻，不是总量上限） */
  workspaceMaxFiles: z.number().int().positive().default(500),
  /** 遍历目录的深度上限（噪音目录已单独排除；真正的深层内容靠它兜底防递归异常） */
  workspaceMaxDepth: z.number().int().positive().default(16),
})

export type FileConfigValue = z.infer<typeof FileConfigSchema>

export const DEFAULT_FILE_CONFIG: FileConfigValue = FileConfigSchema.parse({})

/** 部署上限（env）：只夹这几个会撑爆边界的旋钮 */
export const normalizeFileConfig = (config: FileConfigValue, caps?: FileCaps): FileConfigValue => {
  const file = (caps as (FileCaps & { file?: FileEnvCaps }) | undefined)?.file
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

/**
 * 九个文件工具的入参 schema（**文件域自己拥有**；runtime 的模型面另有副本）。
 * 这里保留 re-export 形状，服务层 / HTTP 层现有 import 不用改。
 */
export const SubmitInputSchema = z.object({
  filePath: z.string().min(1).max(1024).describe('workspace 里要提交的文件路径'),
  fileKey: z.string().min(1).max(255).describe('会话内逻辑路径，如 reports/q1.pdf'),
})

export const DownloadInputSchema = z.object({
  fileKey: z.string().min(1).max(255).describe('本会话文件路径'),
  filePath: z.string().min(1).max(1024).optional().describe('落盘位置（workspace 内）'),
})

export const ListInputSchema = z.object({})

export const ReadFileInputSchema = z.object({
  filePath: z.string().min(1).max(1024).describe('workspace 内的文件路径'),
  offset: z.number().int().min(1).optional().describe('起始行（1-based）'),
  limit: z.number().int().positive().max(500).optional().describe('这一页最多多少行'),
})

export const FileSearchInputSchema = z.object({
  keywords: z.string().min(1).max(200).describe('空格分隔的多个关键词（AND）'),
  caseSensitive: z.boolean().optional().describe('是否区分大小写'),
  pathPrefix: z.string().max(255).optional().describe('只搜这个子目录'),
  maxResults: z.number().int().positive().max(200).optional().describe('最多返回多少条'),
})

export const WorkspaceFilesInputSchema = z.object({
  pathPrefix: z.string().max(255).optional().describe('只列这个子目录'),
  includeCaches: z.boolean().optional().describe('是否包含缓存与入站副本'),
  offset: z.number().int().min(0).optional().describe('分页起点'),
})

export const WriteFileInputSchema = z.object({
  filePath: z.string().min(1).max(1024).describe('workspace 内目标路径'),
  content: z.string().max(1_000_000).describe('完整文件内容（UTF-8）'),
})

export const ReplaceFileInputSchema = z.object({
  filePath: z.string().min(1).max(1024).describe('workspace 内目标文件路径'),
  oldText: z.string().min(1).max(10_000).describe('要替换的原文（精确匹配）'),
  newText: z.string().max(1_000_000).describe('替换后的内容；空串 = 删除'),
  all: z.boolean().optional().describe('是否替换多处'),
})

export const AppendFileInputSchema = z.object({
  filePath: z.string().min(1).max(1024).describe('workspace 内目标文件路径'),
  content: z.string().min(1).max(1_000_000).describe('追加内容（UTF-8）'),
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
