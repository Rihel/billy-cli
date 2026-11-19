import { z } from 'zod'

/**
 * 工作空间（AI 执行环境）的运行契约。
 *
 * 分工（方案 B，见 `docs/design/workspace.md` §7）：
 * - **main** 管 CRUD / 配置 / `desired_status`，是 `ai_workspaces` 的唯一写方；
 * - **workspace-service** 只执行（ensure / destroy / exec / fs / status），
 *   对 `ai_workspaces` **只读**（按 id 取配置），运行态不落库；
 * - 能力调用走网关（`bash` / `file-*` → workspace-service）。
 */

/** 执行后端 */
export const WorkspaceBackendSchema = z.enum(['local', 'container', 'microvm'])
export type WorkspaceBackend = z.infer<typeof WorkspaceBackendSchema>

/** 用户意图状态（实际运行态由 workspace-service 实时返回，不落库） */
export const WorkspaceDesiredStatusSchema = z.enum(['running', 'stopped'])
export type WorkspaceDesiredStatus = z.infer<typeof WorkspaceDesiredStatusSchema>

/** 工作区文件权限 */
export const WorkspaceFileAccessSchema = z.enum(['read-only', 'write'])
export type WorkspaceFileAccess = z.infer<typeof WorkspaceFileAccessSchema>

/** 实际运行态 */
export const WorkspaceRuntimeStateSchema = z.enum(['running', 'stopped', 'unknown'])
export type WorkspaceRuntimeState = z.infer<typeof WorkspaceRuntimeStateSchema>

/** 工作区完整配置（main 写、执行面只读） */
export const WorkspaceConfigSchema = z.object({
  id: z.string().min(1).max(20),
  name: z.string().min(1).max(64),
  backend: WorkspaceBackendSchema,
  /** container 后端必填：`billy-workspace:<tag>` */
  image: z.string().min(1).max(128).optional(),
  /** backend 相关配置（local 的 root / container 的 workdir 等） */
  location: z.record(z.string(), z.unknown()).optional(),
  fileAccess: WorkspaceFileAccessSchema,
})
export type WorkspaceConfig = z.infer<typeof WorkspaceConfigSchema>

/** 按 id 操作执行面（配置由执行面自己只读查表） */
export const WorkspaceIdRequestSchema = z.object({
  workspaceId: z.string().min(1).max(64),
})
export type WorkspaceIdRequest = z.infer<typeof WorkspaceIdRequestSchema>

/** ensure：创建 / 唤醒容器；返回运行态 */
export const WorkspaceEnsureResponseSchema = z.object({
  workspaceId: z.string(),
  state: WorkspaceRuntimeStateSchema,
  containerId: z.string().optional(),
  startedAt: z.number().int().nonnegative().optional(),
})
export type WorkspaceEnsureResponse = z.infer<typeof WorkspaceEnsureResponseSchema>

export const WorkspaceDestroyResponseSchema = z.object({ removed: z.boolean() })
export type WorkspaceDestroyResponse = z.infer<typeof WorkspaceDestroyResponseSchema>

/** status：只查不起 */
export const WorkspaceStatusResponseSchema = z.object({
  workspaceId: z.string(),
  state: WorkspaceRuntimeStateSchema,
  containerId: z.string().optional(),
  startedAt: z.number().int().nonnegative().optional(),
  lastUsedAt: z.number().int().nonnegative().optional(),
})
export type WorkspaceStatusResponse = z.infer<typeof WorkspaceStatusResponseSchema>

/** exec：在环境内跑一条命令 */
export const WorkspaceExecRequestSchema = z.object({
  workspaceId: z.string().min(1).max(64),
  command: z.string().min(1).max(2_000),
  cwd: z.string().min(1).max(512).optional(),
  timeoutMs: z.number().int().positive().max(1_800_000).optional(),
  maxOutputBytes: z
    .number()
    .int()
    .positive()
    .max(16 * 1024 * 1024)
    .optional(),
})
export type WorkspaceExecRequest = z.infer<typeof WorkspaceExecRequestSchema>

export const WorkspaceExecResultSchema = z.object({
  ok: z.boolean(),
  exitCode: z.number().int(),
  stdout: z.string(),
  stderr: z.string(),
  durationMs: z.number().int().nonnegative(),
  truncated: z.boolean().optional(),
  /** 实际执行环境：容器 / 沙箱 / 宿主 */
  runtime: z.enum(['sandbox', 'local', 'container', 'microvm']).optional(),
  /** 实际文件权限档位 */
  mode: z.enum(['read-only', 'workspace-write', 'danger-full-access']).optional(),
  /** 失败原因（`ok=false` 时） */
  reason: z.string().optional(),
  message: z.string().optional(),
})
export type WorkspaceExecResult = z.infer<typeof WorkspaceExecResultSchema>

/** fs：统一文件操作（容器后端经 docker exec 实现） */
export const WorkspaceFsOpSchema = z.enum([
  'list',
  'read',
  'read-bytes',
  'write',
  'write-bytes',
  'append',
  'replace',
  'stat',
  'remove',
  'search',
])
export type WorkspaceFsOp = z.infer<typeof WorkspaceFsOpSchema>

export const WorkspaceFsRequestSchema = z.object({
  workspaceId: z.string().min(1).max(64),
  op: WorkspaceFsOpSchema,
  path: z.string().min(1).max(512),
  /** write / append / replace 的内容 */
  content: z.string().optional(),
  /** write-bytes 的二进制内容（base64） */
  base64: z.string().optional(),
  /** replace 的查找串 */
  find: z.string().optional(),
  /** search 的关键词 */
  query: z.string().optional(),
  /** list 是否递归 */
  recursive: z.boolean().optional(),
  /** 单次返回上限（条 / 字节） */
  limit: z.number().int().positive().max(10_000).optional(),
})
export type WorkspaceFsRequest = z.infer<typeof WorkspaceFsRequestSchema>

export const WorkspaceFsResultSchema = z.object({
  ok: z.boolean(),
  data: z.unknown().optional(),
  reason: z.string().optional(),
  message: z.string().optional(),
})
export type WorkspaceFsResult = z.infer<typeof WorkspaceFsResultSchema>

/** 执行面内部错误码（HTTP 200 + ok=false，对齐能力协议） */
export const WorkspaceErrorReasonSchema = z.enum([
  'not-found',
  'invalid-input',
  'unsafe-path',
  'runtime-unavailable',
  'exec-failed',
  'timeout',
])
export type WorkspaceErrorReason = z.infer<typeof WorkspaceErrorReasonSchema>
