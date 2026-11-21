import { z } from 'zod'
import { BaseModelSchema } from './base.schema'

/** 执行后端 */
export const WorkspaceBackendSchema = z.enum(['local', 'container', 'microvm'])
export type WorkspaceBackend = z.infer<typeof WorkspaceBackendSchema>

/** 工作区文件权限 */
export const WorkspaceFileAccessSchema = z.enum(['read-only', 'write'])
export type WorkspaceFileAccess = z.infer<typeof WorkspaceFileAccessSchema>

/** 用户意图状态（实际运行态由 `runtime.state` 实时返回） */
export const WorkspaceDesiredStatusSchema = z.enum(['running', 'stopped'])
export type WorkspaceDesiredStatus = z.infer<typeof WorkspaceDesiredStatusSchema>

/** 实际运行态 */
export const WorkspaceRuntimeStateSchema = z.enum(['running', 'stopped', 'unknown'])
export type WorkspaceRuntimeState = z.infer<typeof WorkspaceRuntimeStateSchema>

/** 工作区（AI 执行环境）：配置 + 用户意图 + 实时运行态 */
export const WorkspaceModelSchema = BaseModelSchema.extend({
  /** 归属主体（超管会看到其他人的工作区，页面据此区分同名的「默认工作区」） */
  ownerType: z.enum(['user', 'admin']),
  ownerId: z.string(),
  /** 归属人展示名（邮箱）；查不到时为 null */
  ownerName: z.string().nullable(),
  name: z.string(),
  isDefault: z.boolean(),
  backend: WorkspaceBackendSchema,
  image: z.string().nullable(),
  fileAccess: WorkspaceFileAccessSchema,
  desiredStatus: WorkspaceDesiredStatusSchema,
  runtime: z.object({
    state: WorkspaceRuntimeStateSchema,
    containerId: z.string().optional(),
    startedAt: z.number().optional(),
  }),
})
export type WorkspaceModel = z.infer<typeof WorkspaceModelSchema>

export const WorkspaceIdSchema = z.object({ id: z.string().min(1).max(20) })
export type WorkspaceIdDto = z.infer<typeof WorkspaceIdSchema>

export const WorkspaceCreateSchema = z.object({
  name: z.string().min(1).max(64).optional(),
  backend: WorkspaceBackendSchema.optional(),
  image: z.string().max(128).optional(),
  fileAccess: WorkspaceFileAccessSchema.optional(),
})
export type WorkspaceCreateDto = z.infer<typeof WorkspaceCreateSchema>

export const WorkspaceUpdateSchema = z.object({
  id: z.string().min(1).max(20),
  name: z.string().min(1).max(64).optional(),
  image: z.string().max(128).nullable().optional(),
  fileAccess: WorkspaceFileAccessSchema.optional(),
})
export type WorkspaceUpdateDto = z.infer<typeof WorkspaceUpdateSchema>

/**
 * 工作区文件（只读浏览，后台工作区卡片上的「文件」弹窗）。
 *
 * 只给**元信息**：文件列表与内容都从执行面按需读，不在库里缓存。
 * 内容读取有上限（见 `WORKSPACE_FILE_PREVIEW_MAX_BYTES`）：超出就明确拒绝，
 * 不把整份大文件塞进 HTTP / 浏览器。
 */
export const WorkspaceFileEntrySchema = z.object({
  /** 相对工作区根目录的路径 */
  path: z.string(),
  size: z.number().int().nonnegative(),
  mtime: z.number().nonnegative(),
})
export type WorkspaceFileEntry = z.infer<typeof WorkspaceFileEntrySchema>

export const WorkspaceFilesModelSchema = z.object({
  entries: z.array(WorkspaceFileEntrySchema),
})
export type WorkspaceFilesModel = z.infer<typeof WorkspaceFilesModelSchema>

export const WorkspaceFileReadSchema = z.object({
  id: z.string().min(1).max(20),
  path: z.string().min(1).max(512),
})
export type WorkspaceFileReadDto = z.infer<typeof WorkspaceFileReadSchema>

export const WorkspaceFileContentModelSchema = z.object({
  path: z.string(),
  content: z.string(),
  bytes: z.number().int().nonnegative(),
})
export type WorkspaceFileContentModel = z.infer<typeof WorkspaceFileContentModelSchema>

export const WorkspaceFileDownloadSchema = z.object({
  id: z.string().min(1).max(20),
  path: z.string().min(1).max(512),
})
export type WorkspaceFileDownloadDto = z.infer<typeof WorkspaceFileDownloadSchema>

/** 下载：服务端读字节转 base64（有体积上限，超了直接拒绝） */
export const WorkspaceFileBlobModelSchema = z.object({
  path: z.string(),
  filename: z.string(),
  base64: z.string(),
  bytes: z.number().int().nonnegative(),
})
export type WorkspaceFileBlobModel = z.infer<typeof WorkspaceFileBlobModelSchema>
