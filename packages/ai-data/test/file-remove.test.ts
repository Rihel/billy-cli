import { describe, expect, it, vi } from 'vitest'
import { FileService } from '../src/file/file.service.js'
import { FileDeniedError } from '../src/file/file.errors.js'

/**
 * 单文件删除（硬删）：行 + 对象存储一起删。
 *
 * 语义要点（2026-11-21 加）：
 * - **硬删**：`ai_files` 行物理删除，不留软删残行（那是会话清理才用的语义）；
 * - 会话侧入口带 `conversationId`，归属不符按"文件不存在"处理（不泄露别的会话有没有这个 id）；
 * - 对象删除失败只记 warn、不阻断 —— 行是事实源，孤儿对象比"删不掉"更好收拾。
 */

const ROW = {
  id: 'f1',
  conversationId: 'c1',
  key: 'admin/c1/a.md',
  source: 'ai',
  filename: 'a.md',
  mediaType: 'text/markdown',
  bytes: 3,
  sha256: null,
  createdAt: new Date(),
  updatedAt: new Date(),
}

const make = (
  over: { row?: typeof ROW | null; storageEnabled?: boolean; removeFails?: boolean } = {},
) => {
  const row = over.row === undefined ? ROW : over.row
  const files = {
    findById: vi.fn(async () => row),
    hardDelete: vi.fn(async () => true),
  }
  const storage = {
    enabled: over.storageEnabled ?? true,
    removeObject: vi.fn(async () => {
      if (over.removeFails) throw new Error('oss down')
      return { removed: true }
    }),
  }
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const service = new FileService(storage as never, files as never, logger as never)
  return { service, files, storage, logger }
}

describe('FileService.remove（硬删）', () => {
  it('删对象 + 物理删行，返回 removed', async () => {
    const { service, files, storage } = make()

    const result = await service.remove({ fileId: 'f1' })

    expect(result).toEqual({ removed: true })
    expect(storage.removeObject).toHaveBeenCalledWith({ key: ROW.key })
    expect(files.hardDelete).toHaveBeenCalledWith('f1')
  })

  it('会话侧归属不符 → 按"文件不存在"拒绝，什么都不删', async () => {
    const { service, files, storage } = make()

    await expect(service.remove({ fileId: 'f1', conversationId: 'other' })).rejects.toBeInstanceOf(
      FileDeniedError,
    )
    expect(storage.removeObject).not.toHaveBeenCalled()
    expect(files.hardDelete).not.toHaveBeenCalled()
  })

  it('行不存在 → 拒绝（幂等入口也不假装成功）', async () => {
    const { service, files } = make({ row: null })

    await expect(service.remove({ fileId: 'missing' })).rejects.toBeInstanceOf(FileDeniedError)
    expect(files.hardDelete).not.toHaveBeenCalled()
  })

  it('对象删除失败不阻断：记 warn，行照样硬删', async () => {
    const { service, files, logger } = make({ removeFails: true })

    const result = await service.remove({ fileId: 'f1' })

    expect(result).toEqual({ removed: true })
    expect(logger.warn).toHaveBeenCalled()
    expect(files.hardDelete).toHaveBeenCalledWith('f1')
  })

  it('入站附件（source=user）不删对象：内容寻址、可能被别的会话共用，只删本会话的引用行', async () => {
    const { service, files, storage } = make({ row: { ...ROW, source: 'user' } })

    const result = await service.remove({ fileId: 'f1' })

    expect(result).toEqual({ removed: true })
    expect(storage.removeObject).not.toHaveBeenCalled()
    expect(files.hardDelete).toHaveBeenCalledWith('f1')
  })

  it('对象存储未启用时跳过删对象，只删行', async () => {
    const { service, files, storage } = make({ storageEnabled: false })

    await service.remove({ fileId: 'f1' })

    expect(storage.removeObject).not.toHaveBeenCalled()
    expect(files.hardDelete).toHaveBeenCalledWith('f1')
  })
})
