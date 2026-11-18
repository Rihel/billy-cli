import { z } from 'zod'
import { AiMemoryKindField, MEMORY_CONTENT_MAX } from '@repo/shared'
import {
  AppendFileInputSchema,
  DownloadInputSchema,
  FileSearchInputSchema,
  ListInputSchema,
  ReadFileInputSchema,
  ReplaceFileInputSchema,
  SubmitInputSchema,
  WorkspaceFilesInputSchema,
  WriteFileInputSchema,
} from '@repo/ai-data'

/**
 * 通用能力服务自己的入参定义（**执行侧唯一来源**）。
 *
 * 描述按"够模型用"写；runtime 的模型面另有完整文案副本。文件类 schema 由
 * `@repo/ai-data`（文件域）提供，这里 re-export 给执行器用。
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
}

export const BashParams = z.object({
  command: z
    .string()
    .min(1)
    .max(2_000)
    .describe(
      '要执行的整条命令行，按当前操作系统 shell 的语法书写；不支持需要持续输入的交互式命令',
    ),
  cwd: z
    .string()
    .min(1)
    .max(512)
    .optional()
    .describe('工作目录（相对默认工作目录，或它的子目录）；不允许跑到工作目录之外'),
})

export const WebFetchParams = z.object({
  url: z.string().min(1).max(2048).optional().describe('要抓的网页地址；首次抓取必填'),
  ref: z.string().min(1).max(64).optional().describe('上一次抓取返回的缓存句柄；读后续页时传它'),
  page: z.number().int().positive().default(1).describe('要第几页（从 1 开始，1 页 = 1000 行）'),
})

export const WebSearchParams = z.object({
  query: z.string().min(1).max(128).describe('搜索词'),
  count: z.number().int().min(1).max(20).default(8).describe('返回多少条（1~20）'),
  needContent: z.boolean().default(false).describe('是否顺带抓回网页正文'),
  question: z.string().min(1).max(128).optional().describe('用户的原始问题'),
})

export const WebRequestParams = z.object({
  url: z.string().min(1).max(2048).optional().describe('请求地址；首次请求必填'),
  method: z
    .enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'])
    .default('GET')
    .describe('HTTP 方法'),
  query: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
    .optional()
    .describe('查询参数'),
  headers: z.record(z.string(), z.string()).optional().describe('自定义请求头'),
  body: z
    .union([z.string(), z.record(z.string(), z.unknown()), z.array(z.unknown())])
    .optional()
    .describe('请求体'),
  ref: z.string().min(1).max(64).optional().describe('上一次请求返回的缓存句柄'),
  page: z.number().int().positive().default(1).describe('要第几页'),
})

export const MemorySaveInputSchema = z.object({
  content: z.string().min(1).max(MEMORY_CONTENT_MAX).describe('要记住的内容'),
  kind: AiMemoryKindField.optional().describe('类型：profile / preference / fact / constraint'),
  key: z.string().min(1).max(64).optional().describe('稳定标识；同一 key 会更新原记忆'),
  pinned: z.boolean().optional().describe('是否每轮都带上'),
})

export const MemorySearchInputSchema = z.object({
  query: z.string().min(1).max(200).describe('关键词（按内容模糊匹配）'),
  limit: z.number().int().min(1).max(50).optional().default(10),
})

export const MemoryForgetInputSchema = z.object({
  id: z.string().min(1).optional().describe('记忆 id'),
  key: z.string().min(1).max(64).optional().describe('稳定标识（与 id 二选一）'),
})

export const ReadToolResultParams = z.object({
  handle: z.string().min(1).max(128).describe('上一页给出的取页句柄'),
  page: z.number().int().positive().optional().describe('要取的页码'),
})

export const FILE_SCHEMAS: Record<string, z.ZodType> = {
  'file-submit': SubmitInputSchema,
  'file-download': DownloadInputSchema,
  'file-list': ListInputSchema,
  'read-file': ReadFileInputSchema,
  'file-search': FileSearchInputSchema,
  'workspace-files': WorkspaceFilesInputSchema,
  'write-file': WriteFileInputSchema,
  'replace-file': ReplaceFileInputSchema,
  'append-file': AppendFileInputSchema,
}

export const MEMORY_SCHEMAS: Record<string, z.ZodType> = {
  'memory-save': MemorySaveInputSchema,
  'memory-search': MemorySearchInputSchema,
  'memory-forget': MemoryForgetInputSchema,
}

export const FILE_TOOL_KEYS: readonly string[] = Object.keys(FILE_SCHEMAS)
export const MEMORY_TOOL_KEYS: readonly string[] = Object.keys(MEMORY_SCHEMAS)
