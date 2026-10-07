import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAppClients } from '@repo/sdk'

/**
 * `createAppClients` 的装配约定（原先两个 app 各抄一份的那段）。
 *
 * node 环境没有 DOM：凭证管理器只在浏览器路径才写 `localStorage`，这里给它一个最小替身。
 */
function createFakeStorage() {
  const map = new Map<string, string>()
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
    clear: () => map.clear(),
    key: (index: number) => [...map.keys()][index] ?? null,
    get length() {
      return map.size
    },
  }
}

describe('createAppClients', () => {
  let storage: ReturnType<typeof createFakeStorage>

  beforeEach(() => {
    storage = createFakeStorage()
    vi.stubGlobal('localStorage', storage)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const build = (tokenKey = 'access-token') =>
    createAppClients({
      tokenKey,
      publicBaseUrl: 'http://public.test',
      serverBaseUrl: 'http://server.test',
    })

  it('saveToken / removeToken 按注入的 tokenKey 读写浏览器端凭证', async () => {
    const clients = build()

    await clients.saveToken('t-1')
    expect(storage.getItem('access-token')).toBe(JSON.stringify({ token: 't-1' }))

    await clients.removeToken()
    expect(storage.getItem('access-token')).toBeNull()
  })

  it('两端 tokenKey 不同则互不覆盖（同域部署下共享 localStorage 的关键约束）', async () => {
    await build('access-token').saveToken('user-token')
    await build('admin-access-token').saveToken('admin-token')

    expect(storage.getItem('access-token')).toBe(
      JSON.stringify({ token: 'user-token' }),
    )
    expect(storage.getItem('admin-access-token')).toBe(
      JSON.stringify({ token: 'admin-token' }),
    )
  })

  it('浏览器端是单例：useServerClient 与 getServerClient 返回同一实例', () => {
    const clients = build()

    expect(clients.useServerClient()).toBe(clients.getServerClient())
  })

  it('服务端客户端每次都新建（无状态，不共享凭证）', () => {
    const clients = build()

    expect(clients.createServerClient('t-1')).not.toBe(
      clients.createServerClient('t-2'),
    )
  })
})
