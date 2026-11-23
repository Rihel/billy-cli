import type { WorkspaceFsRequest, WorkspaceFsResult } from '@repo/contracts'
import {
  WorkspaceFsError,
  workspaceFsReasonOf,
  type WorkspaceFsEntry,
  type WorkspaceFsPort,
  type WorkspaceFsStat,
} from './workspace-fs.port.js'

/**
 * 执行面 fs 端口的**唯一实现**：把 `WorkspaceServiceClient.fs()` 翻译成 `WorkspaceFsPort`。
 *
 * 为什么放在 `@repo/ai-data`：main / common-capability / agent-runtime 三个 app 都要
 * `WORKSPACE_FS_PORT`，之前各自手写一份（README 说「同语义」但实现已经漂移：
 * 有的丢 reason、有的把失败当成功）。端口契约与错误语义归 ai-data，实现也只留一份。
 */

/** 客户端只要求一个 `fs` 方法（`WorkspaceServiceClient` 结构上满足） */
export interface WorkspaceFsTransport {
  fs(request: WorkspaceFsRequest): Promise<WorkspaceFsResult>
}

const dataOf = async (
  client: WorkspaceFsTransport,
  request: WorkspaceFsRequest,
): Promise<Record<string, unknown>> => {
  const result = await client.fs(request)
  if (!result.ok) {
    // reason 必须原样透出：上层据此区分「文件不存在」与「工作区没起」
    throw new WorkspaceFsError(
      workspaceFsReasonOf(result.reason),
      result.message ?? '工作区文件操作失败',
    )
  }
  return (result.data ?? {}) as Record<string, unknown>
}

export const createWorkspaceFsPort = (client: WorkspaceFsTransport): WorkspaceFsPort => ({
  async readText(workspaceId, path) {
    const data = await dataOf(client, { workspaceId, op: 'read', path })
    return String(data.content ?? '')
  },

  async readBytes(workspaceId, path) {
    const data = await dataOf(client, { workspaceId, op: 'read-bytes', path })
    return Buffer.from(String(data.base64 ?? ''), 'base64')
  },

  async writeBytes(workspaceId, path, body) {
    await dataOf(client, {
      workspaceId,
      op: 'write-bytes',
      path,
      base64: body.toString('base64'),
    })
  },

  async writeText(workspaceId, path, content) {
    await dataOf(client, { workspaceId, op: 'write', path, content })
  },

  async appendText(workspaceId, path, content) {
    await dataOf(client, { workspaceId, op: 'append', path, content })
  },

  async mkdir(workspaceId, path) {
    await dataOf(client, { workspaceId, op: 'mkdir', path })
  },

  async stat(workspaceId, path) {
    const data = await dataOf(client, { workspaceId, op: 'stat', path })
    const stat: WorkspaceFsStat = {
      type: data.type === 'dir' ? 'dir' : 'file',
      size: typeof data.size === 'number' ? data.size : 0,
    }
    if (typeof data.mtime === 'number') stat.mtime = data.mtime
    return stat
  },

  async list(workspaceId, path): Promise<WorkspaceFsEntry[]> {
    const data = await dataOf(client, { workspaceId, op: 'list', path })
    const entries = Array.isArray(data.entries) ? data.entries : []
    return entries
      .filter(
        (entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object',
      )
      .filter((entry) => typeof entry.path === 'string')
      .map((entry) => ({
        name:
          typeof entry.name === 'string' ? entry.name : (String(entry.path).split('/').pop() ?? ''),
        path: String(entry.path),
        type: entry.type === 'dir' ? ('dir' as const) : ('file' as const),
        size: typeof entry.size === 'number' ? entry.size : 0,
      }))
  },

  async listTree(workspaceId, path, options) {
    const data = await dataOf(client, {
      workspaceId,
      op: 'list-tree',
      path,
      maxDepth: options.maxDepth,
      excludeDirs: [...options.excludeDirs],
    })
    const entries = Array.isArray(data.entries) ? data.entries : []
    return entries
      .filter(
        (entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object',
      )
      .filter((entry) => typeof entry.path === 'string')
      .map((entry) => ({
        path: String(entry.path),
        size: typeof entry.size === 'number' ? entry.size : 0,
        mtime: typeof entry.mtime === 'number' ? entry.mtime : 0,
      }))
  },

  async remove(workspaceId, path) {
    await dataOf(client, { workspaceId, op: 'remove', path })
  },

  async search(workspaceId, path, query) {
    const data = await dataOf(client, { workspaceId, op: 'search', path, query })
    return Array.isArray(data.matches) ? data.matches.map((item) => String(item)) : []
  },
})
