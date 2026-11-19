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
  stat(workspaceId: string, path: string): Promise<WorkspaceFsStat>
  list(workspaceId: string, path: string): Promise<WorkspaceFsEntry[]>
  remove(workspaceId: string, path: string): Promise<void>
  search(workspaceId: string, path: string, query: string): Promise<string[]>
}

export const WORKSPACE_FS_PORT = Symbol.for('WorkspaceFsPort')
