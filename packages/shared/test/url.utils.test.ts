import { describe, expect, it } from 'vitest'
import {
  createAppUrlConfig,
  DEV_SERVER_URL,
  DEV_STORAGE_URL,
} from '../src/utils/url.utils'

/**
 * 地址解析的机制：回落顺序与 key → URL 拼接。
 * 各 app 的取值（env）由调用方注入，这里只验机制本身。
 */
describe('createAppUrlConfig', () => {
  it('无任何取值时回落到本地开发默认地址', () => {
    const urls = createAppUrlConfig()

    expect(urls.publicServerUrl).toBe(DEV_SERVER_URL)
    expect(urls.serverUrl).toBe(DEV_SERVER_URL)
    expect(urls.storageUrl).toBe(DEV_STORAGE_URL)
  })

  it('未给运行时地址时，服务端地址继承公开地址', () => {
    const urls = createAppUrlConfig({
      publicServerUrl: 'https://api.example.com',
    })

    expect(urls.publicServerUrl).toBe('https://api.example.com')
    expect(urls.serverUrl).toBe('https://api.example.com')
  })

  it('运行时地址优先于公开地址（容器内指内网）', () => {
    const urls = createAppUrlConfig({
      publicServerUrl: 'https://api.example.com',
      runtimeServerUrl: 'http://server:9989',
    })

    expect(urls.publicServerUrl).toBe('https://api.example.com')
    expect(urls.serverUrl).toBe('http://server:9989')
  })

  it('支持自定义缺省回落', () => {
    const urls = createAppUrlConfig({
      fallbackServerUrl: 'http://127.0.0.1:1',
      fallbackStorageUrl: 'http://127.0.0.1:2/bucket',
    })

    expect(urls.publicServerUrl).toBe('http://127.0.0.1:1')
    expect(urls.formatStorageUrl('a.png')).toBe('http://127.0.0.1:2/bucket/a.png')
  })

  it('formatStorageUrl：空 key 返回空串，绝对 URL 原样返回，其余按基地址拼接', () => {
    const urls = createAppUrlConfig({
      storageUrl: 'http://localhost:9000/billy-cli',
    })

    expect(urls.formatStorageUrl('')).toBe('')
    expect(urls.formatStorageUrl('http://cdn.example.com/a.png')).toBe(
      'http://cdn.example.com/a.png',
    )
    expect(urls.formatStorageUrl('https://cdn.example.com/a.png')).toBe(
      'https://cdn.example.com/a.png',
    )
    expect(urls.formatStorageUrl('avatar/a.png')).toBe(
      'http://localhost:9000/billy-cli/avatar/a.png',
    )
  })
})
