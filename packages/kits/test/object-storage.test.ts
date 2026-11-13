import { describe, expect, it, vi } from 'vitest'
import {
  ObjectStorageError,
  ObjectStorageUnavailableError,
} from '../src/foundation/errors/infrastructure-errors.js'
import { ObjectStorage } from '../src/storage/object-storage.js'
import type { StorageConfig } from '../src/storage/storage.config.js'
import { testLogger } from './helpers/logger.js'

/**
 * 对象存储是**可选能力**（README 口径）：没配 endpoint、或 MinIO / S3 不可达，
 * 服务都必须能起来；只有真正用到存储的调用才报错。
 */
const base: StorageConfig = {
  provider: 's3',
  region: 'us-east-1',
  bucket: 'billy-cli',
  accessKeyId: 'minioadmin',
  secretAccessKey: 'minioadmin',
}

describe('ObjectStorage 启动降级', () => {
  it('没配 endpoint：启动不失败，存储能力标记为未启用', async () => {
    const logger = testLogger()
    const warn = vi.spyOn(logger, 'warn')
    const storage = new ObjectStorage(base, {} as never, logger)

    expect(storage.enabled).toBe(false)
    await expect(storage.onApplicationBootstrap()).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledWith('storage.disabled', expect.anything())
  })

  it('没配 endpoint 时调用存储：抛出明确的中文不可用错误，而不是泛化失败', async () => {
    const storage = new ObjectStorage(base, {} as never, testLogger())
    await expect(storage.getObject({ key: 'x.png' })).rejects.toBeInstanceOf(
      ObjectStorageUnavailableError,
    )
  })

  it('endpoint 不可达：启动不失败，首次使用仍会重试并报操作失败', async () => {
    const logger = testLogger()
    const warn = vi.spyOn(logger, 'warn')
    const storage = new ObjectStorage(
      { ...base, endpoint: 'http://127.0.0.1:1' },
      {} as never,
      logger,
    )

    expect(storage.enabled).toBe(true)
    // 启动期的初始化失败只记警告（不抛出，Nest 继续完成 bootstrap）
    await expect(storage.onApplicationBootstrap()).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledWith('storage.init_failed', expect.anything())

    await expect(storage.getObject({ key: 'x.png' })).rejects.toBeInstanceOf(ObjectStorageError)
  })
})
