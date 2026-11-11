import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentFileModel, ChatAttachmentModel } from '@repo/shared'
import { FileService, type FileContext } from '../src/modules/ai/files/file.service.js'
import type { AiFileEntity } from '../src/database/entities/ai-file-entity.js'
import { TEST_TOOL_ENV_CAPS, silentLogger } from './helpers/ai-tool-stack.js'

/** 只实现 FileService 用到的那几个方法；DB 细节不在这个测试里 */
class FakeRepo {
  rows = new Map<string, AiFileEntity>()

  private key(conversationId: string, path: string) {
    return `${conversationId}:${path}`
  }

  async find(conversationId: string, path: string) {
    return this.rows.get(this.key(conversationId, path)) ?? null
  }

  async list(conversationId: string) {
    return [...this.rows.values()].filter((row) => row.conversationId === conversationId)
  }

  async listAllWithDeleted(conversationId: string) {
    return this.list(conversationId)
  }

  async countAndBytes(conversationId: string, excludePath?: string) {
    const rows = (await this.list(conversationId)).filter((row) => row.path !== excludePath)
    return { count: rows.length, bytes: rows.reduce((sum, row) => sum + row.bytes, 0) }
  }

  async upsert(data: Record<string, unknown>) {
    const now = new Date()
    const row = {
      id: String(data.id ?? Math.random().toString(36).slice(2, 12)),
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      ...data,
    } as unknown as AiFileEntity
    this.rows.set(this.key(row.conversationId, row.path), row)
    return row
  }

  async softDeleteByConversation(conversationId: string) {
    for (const [key, row] of this.rows) if (row.conversationId === conversationId) this.rows.delete(key)
  }

  toModel(record: AiFileEntity): AgentFileModel {
    return {
      path: record.path,
      source: record.source === 'user' ? 'user' : 'ai',
      filename: record.filename,
      key: record.key,
      bytes: record.bytes,
      mediaType: record.mediaType,
      sha256: record.sha256,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    }
  }
}

const build = async () => {
  const root = await mkdtemp(join(tmpdir(), 'billy-files-'))
  const repo = new FakeRepo()
  const objects = new Map<string, Buffer>()
  const storage = {
    enabled: true,
    putObject: vi.fn(async ({ key, body }: { key: string; body: Buffer }) => {
      objects.set(key, body)
      return { key }
    }),
    getObject: vi.fn(async ({ key }: { key: string }) => ({
      key,
      body: objects.get(key) ?? Buffer.from(''),
    })),
    removeObject: vi.fn(async ({ key }: { key: string }) => ({ key })),
  }
  const service = new FileService(
    storage as never,
    repo as never,
    silentLogger as never,
    {
      ...TEST_TOOL_ENV_CAPS,
      command: { ...TEST_TOOL_ENV_CAPS.command!, workDir: root },
    } as never,
  )
  const ctx: FileContext = {
    conversationId: 'conv-1',
    userId: 'user-1',
    isAdmin: false,
    runId: 'run-1',
    toolCallId: 'call-1',
  }
  return { root, repo, storage, service, ctx }
}

describe('FileService（文件管理主体）', () => {
  let env: Awaited<ReturnType<typeof build>>
  beforeEach(async () => {
    env = await build()
  })
  afterEach(async () => {
    await rm(env.root, { recursive: true, force: true })
  })

  it('write / read / replace / append 在 workspace 里闭环', async () => {
    const { service, ctx } = env
    await service.writeFile(ctx, { filePath: 'notes/a.md', content: '一\n二\n三' })
    const first = await service.readFile(ctx, { filePath: 'notes/a.md', limit: 2 })
    expect(first.totalLines).toBe(3)
    expect(first.text).toBe('一\n二')
    expect(first.hasMore).toBe(true)

    await service.replaceFile(ctx, { filePath: 'notes/a.md', oldText: '二', newText: '贰' })
    await service.appendFile(ctx, { filePath: 'notes/a.md', content: '\n四' })
    const after = await service.readFile(ctx, { filePath: 'notes/a.md' })
    expect(after.text).toContain('贰')
    expect(after.text).toContain('四')
  })

  it('file-search 走多关键词 AND + 行号', async () => {
    const { service, ctx } = env
    await service.writeFile(ctx, { filePath: 'notes/a.md', content: '计费规则\n其他\n按量计费规则' })
    const result = await service.search(ctx, { keywords: '计费 规则' })
    expect(result.items.map((item) => item.line)).toEqual([1, 3])
    expect(result.totalMatches).toBe(2)
  })

  it('workspace-files 扁平列表默认隐藏 uploads/files', async () => {
    const { service, ctx } = env
    await service.writeFile(ctx, { filePath: 'notes/a.md', content: 'x' })
    await service.writeFile(ctx, { filePath: 'uploads/x.md', content: 'x' })
    const hidden = await service.workspaceFiles(ctx, {})
    expect(hidden.items.map((item) => item.path)).toEqual(['notes/a.md'])
    const all = await service.workspaceFiles(ctx, { includeCaches: true })
    expect(all.items.map((item) => item.path)).toContain('uploads/x.md')
  })

  it('submit 写 OSS 并登记；download 读回工作区', async () => {
    const { service, ctx, storage } = env
    await service.writeFile(ctx, { filePath: 'out/a.md', content: 'hello' })
    const submitted = await service.submit(ctx, { filePath: 'out/a.md', fileKey: 'reports/a.md' })
    expect(submitted.key).toBe('user/user-1/conv-1/reports/a.md')
    expect(storage.putObject).toHaveBeenCalledOnce()

    const downloaded = await service.download(ctx, { fileKey: 'reports/a.md' })
    expect(downloaded.path.endsWith('files/reports/a.md')).toBe(true)
    expect((await stat(downloaded.path)).isFile()).toBe(true)
  })

  it('入站登记 + 物化；清理只删 AI 对象', async () => {
    const { service, ctx, repo, storage } = env
    const attachments: ChatAttachmentModel[] = [
      { key: 'user/user-1/abc.md', filename: 'abc.md', mediaType: 'text/markdown', bytes: 6 },
    ]
    await service.registerInbound(ctx, attachments)
    const rows = await repo.list('conv-1')
    expect(rows[0]?.source).toBe('user')
    expect(rows[0]?.path).toBe('uploads/abc.md')

    await service.materializeInbound(ctx, attachments)
    expect((await stat(join(env.root, 'conv-1', 'uploads', 'abc.md'))).isFile()).toBe(true)

    await service.writeFile(ctx, { filePath: 'out/a.md', content: 'hello' })
    await service.submit(ctx, { filePath: 'out/a.md', fileKey: 'reports/a.md' })
    await service.cleanupConversation('conv-1')
    // AI 对象删了；入站对象保留
    expect(storage.removeObject).toHaveBeenCalledWith({ key: 'user/user-1/conv-1/reports/a.md' })
    expect(storage.removeObject).not.toHaveBeenCalledWith({ key: 'user/user-1/abc.md' })
  })
})
