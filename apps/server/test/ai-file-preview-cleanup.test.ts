import { describe, expect, it, vi } from 'vitest'
import { FileService } from '../src/modules/ai/files/file.service.js'

const logger = {
  log: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}

describe('FileService.cleanupPreviews', () => {
  it('只删除超过 24h 的临时对象', async () => {
    const now = Date.now()
    const storage = {
      enabled: true,
      listObjects: vi.fn(async () => [
        { key: '_preview/admin/c1/old.png', lastModified: new Date(now - 25 * 60 * 60 * 1000) },
        { key: '_preview/admin/c1/new.png', lastModified: new Date(now - 60 * 60 * 1000) },
      ]),
      removeObject: vi.fn(async () => ({ key: 'removed' })),
    }
    const service = new FileService(storage as never, {} as never, logger as never)

    const removed = await service.cleanupPreviews(now)

    expect(removed).toBe(1)
    expect(storage.removeObject).toHaveBeenCalledTimes(1)
    expect(storage.removeObject).toHaveBeenCalledWith({ key: '_preview/admin/c1/old.png' })
  })

  it('存储不可用 / list 失败时不抛错', async () => {
    const storage = {
      enabled: true,
      listObjects: vi.fn(async () => {
        throw new Error('unavailable')
      }),
      removeObject: vi.fn(),
    }
    const service = new FileService(storage as never, {} as never, logger as never)

    await expect(service.cleanupPreviews()).resolves.toBe(0)
    expect(logger.warn).toHaveBeenCalled()
  })
})
