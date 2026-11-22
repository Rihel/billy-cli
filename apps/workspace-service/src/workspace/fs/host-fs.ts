import { appendFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import type { WorkspaceFsRequest, WorkspaceFsResult } from '@repo/contracts'
import { isInside } from './path.js'
import { tmpSuffix } from './tmp.js'

/**
 * **宿主机文件能力**：直接 Node fs 读写，路径必须落在工作区内。
 *
 * 这批 op 的语义是两侧共用的契约（见 `fs/README` 与 `docs/design/workspace-env-contract.md`）；
 * 容器侧把同样的 op 翻译成 shell 命令（`container-fs.ts`），两边行为由一致性测试对齐。
 */
export type HostFs = (root: string, request: WorkspaceFsRequest) => Promise<WorkspaceFsResult>

export const hostFs: HostFs = async (
  root: string,
  request: WorkspaceFsRequest,
): Promise<WorkspaceFsResult> => {
  const target = resolve(root, request.path)
  if (!isInside(root, target)) {
    return { ok: false, reason: 'unsafe-path', message: '路径必须工作区内' }
  }
  try {
    switch (request.op) {
      case 'list': {
        const entries = await readdir(target, { withFileTypes: true })
        // 只给名字 / 相对路径 / 类型：容器侧一次 `ls` 拿不到 size 与 mtime，
        // 要更多信息用 `list-tree`（一次 find 全带回）。两边语义必须一致。
        return {
          ok: true,
          data: {
            entries: entries.map((entry) => ({
              name: entry.name,
              path: relative(root, join(target, entry.name)),
              type: entry.isDirectory() ? 'dir' : 'file',
            })),
          },
        }
      }
      case 'list-tree': {
        // 本地后端：一次递归读完（每个目录一次 readdir，不再逐文件 stat 往返）
        const excluded = new Set(request.excludeDirs ?? [])
        const maxDepth = request.maxDepth ?? 16
        const entries: { path: string; size: number; mtime: number }[] = []
        const walk = async (dir: string, depth: number): Promise<void> => {
          if (depth > maxDepth) return
          const children = await readdir(dir, { withFileTypes: true }).catch(() => [])
          for (const child of children) {
            if (child.isSymbolicLink()) continue
            const full = join(dir, child.name)
            if (child.isDirectory()) {
              if (excluded.has(child.name)) continue
              await walk(full, depth + 1)
              continue
            }
            if (!child.isFile()) continue
            const info = await stat(full).catch(() => null)
            if (!info) continue
            entries.push({ path: relative(target, full), size: info.size, mtime: info.mtimeMs })
          }
        }
        await walk(target, 0)
        return { ok: true, data: { entries } }
      }
      case 'read': {
        const content = await readFile(target, 'utf8')
        return {
          ok: true,
          data: { path: request.path, content, bytes: Buffer.byteLength(content) },
        }
      }
      case 'read-bytes': {
        const body = await readFile(target)
        return { ok: true, data: { base64: body.toString('base64'), bytes: body.length } }
      }
      case 'write-bytes': {
        const body = Buffer.from(request.base64 ?? '', 'base64')
        await writeAtomic(target, body)
        return { ok: true, data: { path: request.path, bytes: body.length } }
      }
      case 'write':
      case 'replace':
      case 'append': {
        const content = request.content ?? ''
        if (request.op === 'append') {
          await mkdir(dirname(target), { recursive: true })
          await appendFile(target, content, 'utf8')
        } else {
          await writeAtomic(target, content)
        }
        return { ok: true, data: { path: request.path, bytes: Buffer.byteLength(content) } }
      }
      case 'stat': {
        const info = await stat(target)
        return {
          ok: true,
          data: {
            path: request.path,
            type: info.isDirectory() ? 'dir' : 'file',
            size: info.size,
            mtime: info.mtimeMs,
          },
        }
      }
      case 'remove': {
        await rm(target, { recursive: true, force: true })
        return { ok: true, data: { path: request.path, removed: true } }
      }
      case 'search': {
        const entries = await readdir(target, { withFileTypes: true, recursive: true })
        const needle = request.query ?? ''
        const matches: string[] = []
        for (const entry of entries) {
          if (!entry.isFile()) continue
          const full = join(entry.parentPath ?? target, entry.name)
          const content = await readFile(full, 'utf8').catch(() => '')
          if (content.includes(needle)) matches.push(relative(root, full))
        }
        return { ok: true, data: { matches } }
      }
    }
  } catch (error) {
    return {
      ok: false,
      reason: 'exec-failed',
      message: error instanceof Error ? error.message : String(error),
    }
  }
}

const writeAtomic = async (target: string, body: string | Buffer): Promise<void> => {
  await mkdir(dirname(target), { recursive: true })
  const tmp = `${target}${tmpSuffix()}`
  try {
    await writeFile(tmp, body)
    await rename(tmp, target)
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined)
    throw error
  }
}
