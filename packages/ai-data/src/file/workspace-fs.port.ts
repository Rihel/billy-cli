import { z } from 'zod'

/**
 * 工作区文件系统端口（执行面改造的接缝）。
 *
 * `FileService` 现在直接调 `node:fs` 操作 `{workspaceRoot}/{conversationId}` 的本地目录。
 * 工作区迁到容器 / 远程后，这些原语要能换成「经 workspace-service 的 fs」。
 *
 * 端口只描述**原语**，不描述业务：分页、噪音目录、软链校验仍留在 `FileService`，
 * 这样换实现时模型面行为不变。v1 默认实现仍是本地 fs（`LocalWorkspaceFs`）。
 */
export const WorkspaceFsEntrySchema = z.object({
  name: z.string(),
  path: z.string(),
  type: z.enum(['file', 'dir']),
  size: z.number().int().nonnegative().default(0),
})
export type WorkspaceFsEntry = z.infer<typeof WorkspaceFsEntrySchema>

export const WorkspaceFsStatSchema = z.object({
  type: z.enum(['file', 'dir']),
  size: z.number().int().nonnegative(),
  /** 毫秒时间戳（远端返回 Y 秒 × 1000） */
  mtime: z.number().int().nonnegative().optional(),
})
export type WorkspaceFsStat = z.infer<typeof WorkspaceFsStatSchema>

export interface WorkspaceFsPort {
  readText(workspaceId: string, path: string): Promise<string>
  /** 二进制读（预览 / 下载 / 哈希用） */
  readBytes(workspaceId: string, path: string): Promise<Buffer>
  /** 二进制写（入站附件物化） */
  writeBytes(workspaceId: string, path: string, body: Buffer): Promise<void>
  writeText(workspaceId: string, path: string, content: string): Promise<void>
  appendText(workspaceId: string, path: string, content: string): Promise<void>
  mkdir(workspaceId: string, path: string): Promise<void>
  stat(workspaceId: string, path: string): Promise<WorkspaceFsStat>
  list(workspaceId: string, path: string): Promise<WorkspaceFsEntry[]>
  /**
   * 一次拿回整棵树（路径 / 大小 / mtime）：容器后端用单次 `find` 实现。
   *
   * 可选：驱动不支持时 FileService 回落到逐目录 `list` + 逐文件 `stat`。
   */
  listTree?(
    workspaceId: string,
    path: string,
    options: { maxDepth: number; excludeDirs: readonly string[] },
  ): Promise<{ path: string; size: number; mtime: number }[]>
  remove(workspaceId: string, path: string): Promise<void>
  search(workspaceId: string, path: string, query: string): Promise<string[]>
}

export const WORKSPACE_FS_PORT = Symbol.for('WorkspaceFsPort')

/**
 * 执行面拒绝原因（与 `@repo/contracts` 的 `WorkspaceErrorReason` 同集合）。
 *
 * 为什么不能在端口层直接抛 `Error(message)`：`not-found`（文件不存在）、
 * `runtime-unavailable`（工作区没起）与 `unsafe-path`（越界）对上层的含义完全不同 ——
 * 统一成一句话后，预览只能笼统报「不是普通文件」，真实原因全丢（issue A / issue 4）。
 */
export type WorkspaceFsFailureReason =
  | 'not-found'
  | 'invalid-input'
  | 'unsafe-path'
  | 'runtime-unavailable'
  | 'exec-failed'
  | 'timeout'
  | 'unknown'

const FAILURE_REASONS = new Set<string>([
  'not-found',
  'invalid-input',
  'unsafe-path',
  'runtime-unavailable',
  'exec-failed',
  'timeout',
])

export const workspaceFsReasonOf = (value: unknown): WorkspaceFsFailureReason =>
  typeof value === 'string' && FAILURE_REASONS.has(value)
    ? (value as WorkspaceFsFailureReason)
    : 'unknown'

/** 端口调用失败：保留执行面原样的 reason，供上层翻成业务错误码 / 语义 */
export class WorkspaceFsError extends Error {
  readonly reason: WorkspaceFsFailureReason

  constructor(reason: WorkspaceFsFailureReason, message: string) {
    super(message)
    this.name = 'WorkspaceFsError'
    this.reason = reason
  }
}
