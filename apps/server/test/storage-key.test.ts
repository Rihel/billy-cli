import { describe, expect, it } from 'vitest'
import { AppErrorCodes } from '@repo/shared'
import { StorageKeyForbiddenError, StorageKeyInvalidError } from '../src/modules/storage/errors.js'
import { assertDownloadKey, resolveUploadKey } from '../src/modules/storage/storage-key.js'

const catchCode = (fn: () => unknown): number => {
  try {
    fn()
  } catch (error) {
    return (error as { code?: number }).code ?? -1
  }
  throw new Error('未抛出预期错误')
}

describe('resolveUploadKey（上传 key 策略）', () => {
  it('管理员 / 无身份：key 原样（不破坏历史对象路径）', () => {
    expect(resolveUploadKey({ key: 'report/2026.pdf' })).toBe('report/2026.pdf')
    expect(resolveUploadKey({ key: 'abc123.jpeg', userId: null })).toBe('abc123.jpeg')
  })

  it('前台用户：改写进自己的命名空间（前端用返回的 key 落库）', () => {
    expect(resolveUploadKey({ key: '9f8e7d.png', userId: 'u-1' })).toBe('user/u-1/9f8e7d.png')
  })

  it('前台用户：目录穿越被压平成最后一段', () => {
    expect(resolveUploadKey({ key: '../../etc/passwd', userId: 'u-1' })).toBe('user/u-1/passwd')
  })

  it('前台用户：伪造他人前缀无效（压平后落到自己名下）', () => {
    expect(resolveUploadKey({ key: 'user/u-999/steal.png', userId: 'u-1' })).toBe(
      'user/u-1/steal.png',
    )
  })

  it('前台用户：非法字符被过滤', () => {
    expect(resolveUploadKey({ key: 'a b*?.png', userId: 'u-1' })).toBe('user/u-1/ab.png')
  })

  it('前台用户：已在自己前缀下时幂等', () => {
    const once = resolveUploadKey({ key: 'x.png', userId: 'u-1' })
    expect(resolveUploadKey({ key: once, userId: 'u-1' })).toBe(once)
  })

  it('空 key / 过滤后为空 → 3201', () => {
    expect(catchCode(() => resolveUploadKey({ key: '' }))).toBe(AppErrorCodes.StorageKeyInvalid)
    expect(catchCode(() => resolveUploadKey({ key: '   ' }))).toBe(AppErrorCodes.StorageKeyInvalid)
    expect(catchCode(() => resolveUploadKey({ key: 'a/', userId: 'u-1' }))).toBe(
      AppErrorCodes.StorageKeyInvalid,
    )
    expect(catchCode(() => resolveUploadKey({ key: '***', userId: 'u-1' }))).toBe(
      AppErrorCodes.StorageKeyInvalid,
    )
  })

  it('非法 key 抛的是 StorageKeyInvalidError 实例', () => {
    expect(() => resolveUploadKey({ key: '' })).toThrowError(StorageKeyInvalidError)
  })
})

describe('assertDownloadKey（下载 key 策略）', () => {
  it('管理员 / 无身份：放行任意 key', () => {
    expect(() => assertDownloadKey({ key: 'report/2026.pdf' })).not.toThrow()
    expect(() => assertDownloadKey({ key: 'x.png', userId: null })).not.toThrow()
  })

  it('前台用户：自己的前缀放行', () => {
    expect(() => assertDownloadKey({ key: 'user/u-1/a.png', userId: 'u-1' })).not.toThrow()
  })

  it('前台用户：他人前缀 / 扁平 key 一律 403', () => {
    expect(catchCode(() => assertDownloadKey({ key: 'user/u-2/a.png', userId: 'u-1' }))).toBe(
      AppErrorCodes.StorageKeyForbidden,
    )
    expect(catchCode(() => assertDownloadKey({ key: 'a.png', userId: 'u-1' }))).toBe(
      AppErrorCodes.StorageKeyForbidden,
    )
  })

  it('前缀相近不误放（u-1 不得匹配 u-10）', () => {
    expect(catchCode(() => assertDownloadKey({ key: 'user/u-10/a.png', userId: 'u-1' }))).toBe(
      AppErrorCodes.StorageKeyForbidden,
    )
  })

  it('空 key → 3201；越界抛 StorageKeyForbiddenError 实例', () => {
    expect(catchCode(() => assertDownloadKey({ key: '' }))).toBe(AppErrorCodes.StorageKeyInvalid)
    expect(() => assertDownloadKey({ key: 'a.png', userId: 'u-1' })).toThrowError(
      StorageKeyForbiddenError,
    )
  })
})
