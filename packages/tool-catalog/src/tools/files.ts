import dedent from 'dedent'
import { z } from 'zod'

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

export const ListInputSchema = z.object({})

export const ReadFileInputSchema = z.object({
  filePath: z.string().min(1).max(1024).describe('workspace 内的文件路径（绝对或相对）'),
  offset: z.number().int().min(1).optional().describe('起始行（1-based）；默认 1'),
  limit: z.number().int().positive().max(500).optional().describe('这一页最多多少行；默认 200'),
})

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

export const WriteFileInputSchema = z.object({
  filePath: z.string().min(1).max(1024).describe('workspace 内目标路径；父目录自动创建'),
  content: z.string().max(1_000_000).describe('完整文件内容（UTF-8）；整文件覆盖'),
})

export const ReplaceFileInputSchema = z.object({
  filePath: z.string().min(1).max(1024).describe('workspace 内目标文件路径'),
  oldText: z.string().min(1).max(10_000).describe('要替换的原文；必须精确匹配（含空白）'),
  newText: z.string().max(1_000_000).describe('替换后的内容；空串 = 删除这段'),
  all: z.boolean().optional().describe('默认 false；多处匹配时默认拒绝，要求更长的唯一上下文'),
})

export const AppendFileInputSchema = z.object({
  filePath: z.string().min(1).max(1024).describe('workspace 内目标文件路径；不存在则创建'),
  content: z.string().min(1).max(1_000_000).describe('追加内容（UTF-8）；不会自动加换行'),
})

const base = { category: 'core', scope: 'all', executor: 'worker', version: 1 } as const

export const FILE_SUBMIT_TOOL = {
  ...base,
  key: 'file-submit',
  title: '提交文件到会话',
  params: SubmitInputSchema,
  description: dedent`
    把 workspace 里的一个文件提交为**本会话的 AI 生成文件**（上传对象存储，用户可预览 / 下载）。
    用户上传的原文件已经自动进文件树，不要重复提交；修改后的新文件换一个 fileKey 再提交。
    filePath 传 workspace 路径，fileKey 传会话内路径（不得以 uploads/ 开头）；工具自动拼 userId 与会话 id。
    同一个 fileKey 再提交会覆盖旧版本。不要提交密钥、凭据或工作区之外的文件。
  `,
} as const

export const FILE_DOWNLOAD_TOOL = {
  ...base,
  key: 'file-download',
  title: '下载会话文件到工作区',
  params: DownloadInputSchema,
  description: dedent`
    把本会话的文件从对象存储**下载到 workspace**，返回本地路径；不返回内容。
    入站附件通常已经物化到 uploads/，会直接命中缓存；AI 文件下载到 files/。
    大文件下载后用 read-file 分页读；编辑用 write-file / replace-file / append-file，不要直接改 files/ 缓存。
  `,
} as const

export const FILE_LIST_TOOL = {
  ...base,
  key: 'file-list',
  title: '列出会话文件',
  params: ListInputSchema,
  description: dedent`
    列出本会话的文件（用户上传 + AI 生成），按更新时间倒序返回元数据；不返回文件内容。
    不确定有哪些文件、或忘了 fileKey 时用。只看 workspace 里的文件用 workspace-files。
  `,
} as const

export const READ_FILE_TOOL = {
  ...base,
  key: 'read-file',
  title: '分页读取工作区文件',
  params: ReadFileInputSchema,
  description: dedent`
    分页读 workspace 里的文本文件；默认 200 行 / 16KB，offset 是 1-based 行号，
    返回 totalLines / hasMore / nextOffset。
    大文件不要一次读完：先用 file-search 在整个工作区定位行号，再用 offset 读那一段。
    只读文本；二进制用 bash / python。路径必须在本会话 workspace 内。
  `,
} as const

export const FILE_SEARCH_TOOL = {
  ...base,
  key: 'file-search',
  title: '搜索工作区文件内容',
  params: FileSearchInputSchema,
  description: dedent`
    在整个 workspace 的文本文件里搜关键词；空格分隔多个关键词（同一行必须全部出现），
    返回文件路径 + 行号 + 行内容。大文件先搜后读：拿到行号后用 read-file 的 offset 读上下文。
    跳过二进制 / 软链 / 依赖目录；结果有上限。
  `,
} as const

export const WORKSPACE_FILES_TOOL = {
  ...base,
  key: 'workspace-files',
  title: '列出工作区文件',
  params: WorkspaceFilesInputSchema,
  description: dedent`
    列出 workspace 里的文件，**扁平列表**（不是树）；默认不显示 files/ 下载缓存与 uploads/ 入站副本。
    返回相对路径 / 大小 / mtime，可直接给 read-file / replace-file；要搜索内容用 file-search。
    只看会话文件（OSS）用 file-list。
  `,
} as const

export const WRITE_FILE_TOOL = {
  ...base,
  key: 'write-file',
  title: '写入工作区文件',
  params: WriteFileInputSchema,
  description: dedent`
    把完整内容写入 workspace 文件（整文件覆盖）；父目录自动创建。
    局部改用 replace-file，末尾追加用 append-file。只写文本；单次内容上限 1MB。
    路径必须在本会话 workspace 内；不要写 files/ 缓存（会被重新下载覆盖）。
  `,
} as const

export const REPLACE_FILE_TOOL = {
  ...base,
  key: 'replace-file',
  title: '替换工作区文件内容',
  params: ReplaceFileInputSchema,
  description: dedent`
    在 workspace 文本文件里做**精确字符串替换**（不是正则）；默认要求 oldText 唯一匹配。
    大文件先用 file-search 定位，再拿更长的唯一片段替换。
    只改文本；单次内容上限 1MB；路径必须在本会话 workspace 内。
  `,
} as const

export const APPEND_FILE_TOOL = {
  ...base,
  key: 'append-file',
  title: '追加工作区文件内容',
  params: AppendFileInputSchema,
  description: dedent`
    把内容追加到 workspace 文件末尾；文件不存在则创建。不会自动补换行。
    要改中间用 replace-file，要整文件覆盖用 write-file。
    只写文本；追加后不能超过单文件上限；路径必须在本会话 workspace 内。
  `,
} as const
