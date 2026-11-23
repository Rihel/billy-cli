import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { AppErrorCodes } from '@repo/shared'
import { FileService } from '../src/file/file.service.js'
import {
  FileNotFoundError,
  FileNotPreviewableError,
  FileWorkspaceUnavailableError,
} from '../src/file/file.errors.js'
import { WorkspaceFsError, type WorkspaceFsPort } from '../src/file/workspace-fs.port.js'
import { createWorkspaceFsPort } from '../src/file/workspace-fs.client.js'
import { resolveWorkspacePath } from '../src/file/workspace.js'
import type { FileContext } from '../src/file/file.service.js'

/**
 * 工作区预览的错误语义（issue A / issue 4）：
 * - 执行面说 not-found → 3424（文件不存在），不是「参数不合法」；
 * - 执行面不可用 → 3427（可重试），不是「不是普通文件」；
 * - 目录 / 非文本 → 3425；
 * - 容器会话的**本地残留**不能让真身在执行面的文件被判成 not-found（remote 显式声明）。
 */

const roots: string[] = []
afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true })
})

const make = async (portOver: Partial<WorkspaceFsPort> = {}) => {
  const root = await mkdtemp(join(tmpdir(), 'ai-data-preview-'))
  roots.push(root)
  const files = { find: vi.fn(async () => null) }
  const storage = { enabled: false }
  const logger = { info: vi.fn(), warn: vi.fn(), log: vi.fn(), error: vi.fn() }
  const port: WorkspaceFsPort = {
    readText: vi.fn(async () => ''),
    readBytes: vi.fn(async () => Buffer.from('hello')),
    writeBytes: vi.fn(async () => undefined),
    writeText: vi.fn(async () => undefined),
    appendText: vi.fn(async () => undefined),
    stat: vi.fn(async () => ({ type: 'file' as const, size: 5 })),
    list: vi.fn(async () => []),
    remove: vi.fn(async () => undefined),
    search: vi.fn(async () => []),
    ...portOver,
  }
  const service = new FileService(
    storage as never,
    files as never,
    logger as never,
    { command: { workDir: root } } as never,
    port,
  )
  const ctx: FileContext = {
    conversationId: 'c1',
    workspaceId: 'ws1',
    userId: 'u1',
    isAdmin: false,
    runId: null,
    toolCallId: null,
  }
  return { service, port, logger, root, ctx }
}

describe('previewText（workspace）：执行面错误翻成业务码', () => {
  it('执行面 not-found → FileNotFoundError（3424），不是「不是普通文件」', async () => {
    const { service, ctx, logger } = await make({
      stat: vi.fn(async () => {
        throw new WorkspaceFsError('not-found', 'stat: no such file')
      }),
    })

    const error = await service
      .previewText(ctx, '.agents/demo/SKILL.md', 'workspace')
      .catch((e) => e)

    expect(error).toBeInstanceOf(FileNotFoundError)
    expect(error.code).toBe(AppErrorCodes.FileNotFound)
    expect(logger.warn).toHaveBeenCalledWith(
      'ai.file.preview_stat_failed',
      expect.objectContaining({ reason: 'not-found', path: '.agents/demo/SKILL.md' }),
    )
  })

  it('执行面不可用 → FileWorkspaceUnavailableError（3427，可重试）', async () => {
    const { service, ctx } = await make({
      stat: vi.fn(async () => {
        throw new WorkspaceFsError('runtime-unavailable', '工作区没有在运行')
      }),
    })

    const error = await service.previewText(ctx, 'a.md', 'workspace').catch((e) => e)
    expect(error).toBeInstanceOf(FileWorkspaceUnavailableError)
    expect(error.code).toBe(AppErrorCodes.FileWorkspaceUnavailable)
  })

  it('目录 / 非文本 → FileNotPreviewableError（3425）', async () => {
    const dir = await make({
      stat: vi.fn(async () => ({ type: 'dir' as const, size: 0 })),
    })
    const dirError = await dir.service.previewText(dir.ctx, 'folder', 'workspace').catch((e) => e)
    expect(dirError).toBeInstanceOf(FileNotPreviewableError)
    expect(dirError.code).toBe(AppErrorCodes.FileNotPreviewable)

    const bin = await make()
    const binError = await bin.service
      .previewText(bin.ctx, 'image.png', 'workspace')
      .catch((e) => e)
    expect(binError).toBeInstanceOf(FileNotPreviewableError)
  })

  it('执行面能读时正常返回正文（不因为本地没有文件而失败）', async () => {
    const { service, ctx } = await make()

    const result = await service.previewText(ctx, '.agents/demo/SKILL.md', 'workspace')

    expect(result.text).toBe('hello')
    expect(result.mediaType).toBe('text/markdown')
  })
})

describe('resolveWorkspacePath：执行面显式声明，不按本地目录猜', () => {
  it('remote=true 时跳过本地 realpath（容器会话的本地残留不影响判定）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ai-data-remote-'))
    roots.push(root)
    // 本地只剩「入站附件」残留目录，真身在容器里
    await mkdir(join(root, 'c1', 'uploads'), { recursive: true })
    await writeFile(join(root, 'c1', 'uploads', 'a.png'), 'x')

    const target = await resolveWorkspacePath({
      caps: { command: { workDir: root } } as never,
      conversationId: 'c1',
      path: '.agents/demo/SKILL.md',
      remote: true,
    })

    expect(target).toBe(join(root, 'c1', '.agents/demo/SKILL.md'))
  })

  it('本地模式（remote 未声明）缺文件 → FileDeniedError reason=not-found', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ai-data-local-'))
    roots.push(root)

    const error = await resolveWorkspacePath({
      caps: { command: { workDir: root } } as never,
      conversationId: 'c1',
      path: 'missing.md',
    }).catch((e) => e)

    expect(error.reason).toBe('not-found')
  })
})

describe('createWorkspaceFsPort：执行面 reason 原样透出', () => {
  it('ok=false 带 reason → 抛 WorkspaceFsError（上层据此翻业务码）', async () => {
    const port = createWorkspaceFsPort({
      fs: async () => ({ ok: false, reason: 'unsafe-path', message: '路径越界' }),
    })
    const error = await port.readText('w', '../x').catch((e) => e)
    expect(error).toBeInstanceOf(WorkspaceFsError)
    expect(error.reason).toBe('unsafe-path')
    expect(error.message).toBe('路径越界')
  })

  it('未知 reason → unknown（不把执行面新词当已知语义）', async () => {
    const port = createWorkspaceFsPort({
      fs: async () => ({ ok: false, reason: 'brand-new', message: 'x' }),
    })
    const error = await port.stat('w', 'a').catch((e) => e)
    expect(error.reason).toBe('unknown')
  })

  it('成功时按端口契约映射 stat / list / listTree', async () => {
    const port = createWorkspaceFsPort({
      fs: async (request) => {
        if (request.op === 'stat') return { ok: true, data: { type: 'dir', size: 0, mtime: 5 } }
        if (request.op === 'list') {
          return {
            ok: true,
            data: { entries: [{ name: 'a.md', path: 'a.md', type: 'file', size: 3 }] },
          }
        }
        return { ok: true, data: { entries: [{ path: 'a.md', size: 3, mtime: 9 }] } }
      },
    })

    expect(await port.stat('w', 'd')).toMatchObject({ type: 'dir', mtime: 5 })
    expect(await port.list('w', '.')).toEqual([
      { name: 'a.md', path: 'a.md', type: 'file', size: 3 },
    ])
    expect(await port.listTree?.('w', '.', { maxDepth: 2, excludeDirs: ['node_modules'] })).toEqual(
      [{ path: 'a.md', size: 3, mtime: 9 }],
    )
  })
})

describe('file-search：执行面工作区也要能搜到（stat 不能落回本地）', () => {
  it('远程 port 的 list / stat / readText 串起来能返回命中', async () => {
    const { service, ctx } = await make({
      stat: vi.fn(async (_workspaceId: string, path: string) =>
        path === '.' ? { type: 'dir' as const, size: 0 } : { type: 'file' as const, size: 16 },
      ),
      list: vi.fn(async () => [{ name: 'a.md', path: 'a.md', type: 'file' as const, size: 16 }]),
      readText: vi.fn(async () => '# note\nneedle here\n'),
    })

    const result = await service.search(ctx, { keywords: 'needle' })

    expect(result.items).toEqual([{ filePath: 'a.md', line: 2, text: 'needle here' }])
    expect(result.totalMatches).toBe(1)
  })
})
