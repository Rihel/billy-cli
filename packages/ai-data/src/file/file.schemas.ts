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
 * 九个文件工具的入参 schema 唯一来源是 `@repo/tool-catalog`；
 * 这里 re-export 保持服务层 / HTTP 层现有 import 不变。
 */
export {
  AppendFileInputSchema,
  DownloadInputSchema,
  FileSearchInputSchema,
  ListInputSchema,
  ReadFileInputSchema,
  ReplaceFileInputSchema,
  SubmitInputSchema,
  WorkspaceFilesInputSchema,
  WriteFileInputSchema,
} from '@repo/tool-catalog'

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
