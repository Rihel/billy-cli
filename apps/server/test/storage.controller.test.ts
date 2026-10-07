import { describe, expect, it, vi } from 'vitest'
import type { ObjectStorage } from '@repo/kits'
import { AppErrorCodes } from '@repo/shared'
import { requestContext } from '../src/common/index.js'
import { StorageController } from '../src/modules/storage/index.js'

/**
 * 控制器级测试：验证「身份 → key 策略」的接线（纯函数本身另有 storage-key.test.ts）。
 * 不启动 HTTP：直接实例化控制器，用 `requestContext.run` 模拟守卫写入的身份。
 */
const makeController = () => {
  const getPresignedUrl = vi.fn(async (data: { key: string }) => ({
    key: data.key,
    url: `https://s3.local/${data.key}`,
  }))
  const getDownloadUrl = vi.fn(async (data: { key: string }) => ({
    key: data.key,
    url: `https://s3.local/${data.key}`,
  }))
  const getTemporaryCredentials = vi.fn(async () => ({
    endpoint: 'e',
    bucket: 'b',
    region: 'r',
    accessKeyId: 'a',
    secretAccessKey: 's',
    sessionToken: 't',
    expiration: 1,
  }))
  const storage = {
    getPresignedUrl,
    getDownloadUrl,
    getTemporaryCredentials,
  } as unknown as ObjectStorage

  return { controller: new StorageController(storage), getPresignedUrl, getDownloadUrl, getTemporaryCredentials }
}

const asUser = <T>(userId: string, fn: () => T): T =>
  requestContext.run({ requestId: 'rid', userId, adminId: null }, fn)

const asAdmin = <T>(adminId: string, fn: () => T): T =>
  requestContext.run({ requestId: 'rid', userId: null, adminId }, fn)

const anonymous = <T>(fn: () => T): T =>
  requestContext.run({ requestId: 'rid', userId: null, adminId: null }, fn)

const catchCode = (fn: () => unknown): number => {
  try {
    fn()
  } catch (error) {
    return (error as { code?: number }).code ?? -1
  }
  throw new Error('未抛出预期错误')
}

describe('StorageController（双身份 + key 命名空间约束）', () => {
  it('前台用户上传：统一入口收到带前缀的 key，且响应 key 已改写（前端据此落库）', async () => {
    const { controller, getPresignedUrl } = makeController()

    const result = await asUser('u-1', () =>
      controller.getPresignedUrl({ key: '9f8e7d.png' }),
    )

    expect(getPresignedUrl).toHaveBeenCalledWith({ key: 'user/u-1/9f8e7d.png' })
    expect(result).toEqual({ key: 'user/u-1/9f8e7d.png', url: 'https://s3.local/user/u-1/9f8e7d.png' })
  })

  it('管理员上传：key 原样（历史对象路径不变）', async () => {
    const { controller, getPresignedUrl } = makeController()

    await asAdmin('a-1', () => controller.getPresignedUrl({ key: 'avatar/admin.jpeg' }))

    expect(getPresignedUrl).toHaveBeenCalledWith({ key: 'avatar/admin.jpeg' })
  })

  it('前台用户下载自己的文件：放行', async () => {
    const { controller, getDownloadUrl } = makeController()

    await asUser('u-1', () => controller.getDownloadUrl({ key: 'user/u-1/a.png' }))

    expect(getDownloadUrl).toHaveBeenCalledWith({ key: 'user/u-1/a.png' })
  })

  it('前台用户下载他人文件：403 且不调统一入口', () => {
    const { controller, getDownloadUrl } = makeController()

    const code = catchCode(() =>
      asUser('u-1', () => controller.getDownloadUrl({ key: 'user/u-2/a.png' })),
    )

    expect(code).toBe(AppErrorCodes.StorageKeyForbidden)
    expect(getDownloadUrl).not.toHaveBeenCalled()
  })

  it('前台用户取 STS 临时凭证：403 且不调统一入口（整桶权限不发前台）', () => {
    const { controller, getTemporaryCredentials } = makeController()

    const code = catchCode(() => asUser('u-1', () => controller.getTemporaryCredentials()))

    expect(code).toBe(AppErrorCodes.StorageAdminOnly)
    expect(getTemporaryCredentials).not.toHaveBeenCalled()
  })

  it('管理员取 STS：放行，会话名用管理员 id', async () => {
    const { controller, getTemporaryCredentials } = makeController()

    await asAdmin('a-1', () => controller.getTemporaryCredentials())

    expect(getTemporaryCredentials).toHaveBeenCalledWith({ userId: 'a-1' })
  })

  it('鉴权关闭（无身份）：key 原样放行，STS 不再抛错（回归：原实现用 currentAdminId() 会 500）', async () => {
    const { controller, getPresignedUrl, getTemporaryCredentials } = makeController()

    await anonymous(() => controller.getPresignedUrl({ key: 'flat/key.png' }))
    await anonymous(() => controller.getTemporaryCredentials())

    expect(getPresignedUrl).toHaveBeenCalledWith({ key: 'flat/key.png' })
    expect(getTemporaryCredentials).toHaveBeenCalledWith({ userId: 'anonymous' })
  })

  it('空 key：400（3201）', () => {
    const { controller } = makeController()

    expect(catchCode(() => asUser('u-1', () => controller.getPresignedUrl({ key: '' })))).toBe(
      AppErrorCodes.StorageKeyInvalid,
    )
  })
})
