import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppLogger, Db } from '@repo/kits'
import { WorkspaceAdminService } from '../src/modules/ai-admin/workspace/workspace.service.js'

/**
 * 后台「工作区 · 文件」弹窗的两个只读接口。
 *
 * 钉三件事：
 * 1. **归属**：只认自己的工作区（`requireOwned`）；
 * 2. **不偷偷启动**：工作区没跑就直接报错，绝不因为点开文件而 `ensure` 一个容器；
 * 3. **预览有上限**：超过 512KB 明确拒绝，不把大文件塞进 HTTP。
 */
const OWNER = { ownerType: 'admin' as const, ownerId: 'admin_1' }

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

const makeService = (owned = true) => {
  const repo = {
    findOne: vi.fn(async () =>
      owned
        ? {
            id: 'ws_1',
            ownerType: 'admin',
            ownerId: 'admin_1',
            name: '默认工作区',
            backend: 'container',
            image: null,
            fileAccess: 'write',
            desiredStatus: 'running',
            isDefault: true,
          }
        : null,
    ),
  }
  const db = { getRepository: vi.fn(() => repo) }
  const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() }
  return new WorkspaceAdminService(db as unknown as Db, logger as unknown as AppLogger)
}

/** 假执行面：按 URL 路由，记录每次 fs 调用的 op */
const stubExecutor = (options: {
  state?: string
  entries?: unknown[]
  statSize?: number
  read?: string
}) => {
  const ops: string[] = []
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/v1/workspaces/status')) {
      return json({ workspaceId: 'ws_1', state: options.state ?? 'running' })
    }
    if (url.endsWith('/v1/workspaces/fs')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as { op: string; path: string }
      ops.push(body.op)
      if (body.op === 'list-tree')
        return json({ ok: true, data: { entries: options.entries ?? [] } })
      if (body.op === 'stat') {
        return json({
          ok: true,
          data: { path: body.path, type: 'file', size: options.statSize ?? 10 },
        })
      }
      if (body.op === 'read') {
        return json({ ok: true, data: { path: body.path, content: options.read ?? '' } })
      }
    }
    return json({})
  })
  vi.stubGlobal('fetch', fetchMock)
  return ops
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('工作区文件列表', () => {
  it('运行中：返回文件树条目', async () => {
    const service = makeService()
    stubExecutor({
      entries: [
        { path: 'a.md', size: 12, mtime: 1 },
        { path: 'dir/b.ts', size: 34, mtime: 2 },
      ],
    })

    const result = await service.files(OWNER, 'ws_1')
    expect(result.entries.map((entry) => entry.path)).toEqual(['a.md', 'dir/b.ts'])
  })

  it('未运行：明确报错，且**不去 fs**（不偷偷拉起容器）', async () => {
    const service = makeService()
    const ops = stubExecutor({ state: 'stopped' })

    await expect(service.files(OWNER, 'ws_1')).rejects.toThrow('工作区未运行')
    expect(ops).toEqual([])
  })

  it('不是自己的工作区：NotFound（不泄露存在性）', async () => {
    const service = makeService(false)
    stubExecutor({})

    await expect(service.files(OWNER, 'ws_1')).rejects.toThrow('Workspace not found')
  })
})

describe('工作区文件预览', () => {
  it('文本文件：返回正文', async () => {
    const service = makeService()
    stubExecutor({ statSize: 5, read: 'hello' })

    await expect(service.readFile(OWNER, 'ws_1', 'a.txt')).resolves.toEqual({
      path: 'a.txt',
      content: 'hello',
      bytes: 5,
    })
  })

  it('超过 512KB：直接拒绝，不读正文', async () => {
    const service = makeService()
    const ops = stubExecutor({ statSize: 600 * 1024 })

    await expect(service.readFile(OWNER, 'ws_1', 'big.bin')).rejects.toThrow('超过在线预览上限')
    expect(ops).not.toContain('read')
  })
})

describe('工作区文件下载', () => {
  it('返回 base64 与文件名', async () => {
    const service = makeService()
    stubExecutor({ statSize: 5 })
    // read-bytes 的假响应
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (url.endsWith('/v1/workspaces/status')) {
          return json({ workspaceId: 'ws_1', state: 'running' })
        }
        const body = JSON.parse(String(init?.body ?? '{}')) as { op: string }
        if (body.op === 'stat') {
          return json({ ok: true, data: { path: 'a.png', type: 'file', size: 5 } })
        }
        return json({ ok: true, data: { base64: 'aGVsbG8=' } })
      }),
    )

    await expect(service.downloadFile(OWNER, 'ws_1', 'dir/a.png')).resolves.toEqual({
      path: 'dir/a.png',
      filename: 'a.png',
      base64: 'aGVsbG8=',
      bytes: 5,
    })
  })
})
