import { afterEach, describe, it, expect, vi } from 'vitest'
import {
  // 核心
  HttpClient,
  HttpClientOptions,
  ApiError,
  ApiErrorCodes,
  // 策略
  BearerTokenStrategy,
  ApiKeyStrategy,
  HmacStrategy,
  OAuth2Strategy,
  OAuth2NeedsRefreshError,
  // 管理器
  MemoryCredentialsManager,
  EnvCredentialsManager,
  // 供应器
  EmptyCheckProvider,
  ExpiresAtProvider,
} from '../src/index.js'

// ── 认证策略 ────────────────────────────────────────

describe('BearerTokenStrategy', () => {
  const s = new BearerTokenStrategy()

  it('识别有效凭证', async () => {
    expect(await s.isAuthorization({ token: 'abc' })).toBe(true)
  })

  it('识别空凭证', async () => {
    expect(await s.isAuthorization({ token: '' })).toBe(false)
    expect(await s.isAuthorization({} as any)).toBe(false)
  })

  it('注入 Bearer header', async () => {
    const ctx = await s.getAuthContext({ token: 'my-token' })
    expect(ctx.headers?.Authorization).toBe('Bearer my-token')
  })
})

describe('ApiKeyStrategy', () => {
  const s = new ApiKeyStrategy()

  it('识别有效凭证', async () => {
    expect(await s.isAuthorization({ apiKey: 'xxx' })).toBe(true)
  })

  it('默认注入 header', async () => {
    const ctx = await s.getAuthContext({ apiKey: 'k1' })
    expect(ctx.headers?.['X-API-Key']).toBe('k1')
  })

  it('支持 query 模式', async () => {
    const ctx = await s.getAuthContext({ apiKey: 'k1', location: 'query', keyName: 'api_key' })
    expect(ctx.query?.api_key).toBe('k1')
  })
})

describe('HmacStrategy', () => {
  it('识别有效凭证', async () => {
    const s = new HmacStrategy()
    expect(await s.isAuthorization({ accessKey: 'ak', secretKey: 'sk' })).toBe(true)
    expect(await s.isAuthorization({ accessKey: '' } as any)).toBe(false)
  })

  it('自动签名注入 header', async () => {
    const s = new HmacStrategy()
    const ctx = await s.getAuthContext({ accessKey: 'ak', secretKey: 'sk' })
    expect(ctx.headers?.['X-Hmac-AccessKey']).toBe('ak')
    expect(ctx.headers?.['X-Hmac-Signature']).toBeDefined()
    expect(ctx.headers?.['X-Hmac-Timestamp']).toBeDefined()
    expect(ctx.headers?.['X-Hmac-Nonce']).toBeDefined()
  })

  it('sign 方法可以单独调用', () => {
    const s = new HmacStrategy()
    const sig = s.sign('secret', 'hello')
    expect(typeof sig).toBe('string')
    expect(sig.length).toBe(64) // SHA-256 = 64 hex chars
  })

  it('支持 SHA-384', () => {
    const s = new HmacStrategy({ algorithm: 'SHA-384' })
    const sig = s.sign('secret', 'hello')
    expect(sig.length).toBe(96)
  })

  it('支持 SHA-512', () => {
    const s = new HmacStrategy({ algorithm: 'SHA-512' })
    const sig = s.sign('secret', 'hello')
    expect(sig.length).toBe(128)
  })

  it('autoSign=false 时不签名', async () => {
    const s = new HmacStrategy({ autoSign: false })
    const ctx = await s.getAuthContext({ accessKey: 'ak', secretKey: 'sk' })
    expect(ctx.headers?.['X-Hmac-Signature']).toBeUndefined()
  })
})

describe('OAuth2Strategy', () => {
  it('识别有效凭证', async () => {
    const s = new OAuth2Strategy()
    expect(await s.isAuthorization({ accessToken: 'tok' })).toBe(true)
    expect(await s.isAuthorization({ accessToken: '' })).toBe(false)
  })

  it('注入 Bearer header', async () => {
    const s = new OAuth2Strategy()
    const ctx = await s.getAuthContext({ accessToken: 'tok' })
    expect(ctx.headers?.Authorization).toBe('Bearer tok')
  })

  it('即将过期时抛 OAuth2NeedsRefreshError', async () => {
    const s = new OAuth2Strategy({
      onRefresh: async () => ({ accessToken: 'new' }),
      refreshMarginMs: 60_000,
    })
    const expired = { accessToken: 'old', expiresAt: Date.now() - 1000 }
    await expect(s.getAuthContext(expired)).rejects.toThrow(OAuth2NeedsRefreshError)
  })

  it('refresh 方法刷新凭证', async () => {
    const s = new OAuth2Strategy({
      onRefresh: async () => ({ accessToken: 'refreshed' }),
    })
    const next = await s.refresh({ accessToken: 'old' }, new MemoryCredentialsManager())
    expect(next.accessToken).toBe('refreshed')
  })
})

// ── 凭证管理器 ────────────────────────────────────────

describe('MemoryCredentialsManager', () => {
  it('默认返回空对象', async () => {
    const mgr = new MemoryCredentialsManager()
    expect(await mgr.getCredentials()).toEqual({})
  })

  it('初始值', async () => {
    const mgr = new MemoryCredentialsManager({ token: 'abc' })
    expect(await mgr.getCredentials()).toEqual({ token: 'abc' })
  })

  it('读写', async () => {
    const mgr = new MemoryCredentialsManager()
    await mgr.setCredentials({ token: 'xyz' })
    expect(await mgr.getCredentials()).toEqual({ token: 'xyz' })
  })

  it('清除', async () => {
    const mgr = new MemoryCredentialsManager({ token: 'abc' })
    await mgr.clearCredentials()
    expect(await mgr.getCredentials()).toEqual({})
  })
})

describe('EnvCredentialsManager', () => {
  it('返回构造时传入的凭证', async () => {
    const mgr = new EnvCredentialsManager({ accessKey: 'ak', secretKey: 'sk' })
    expect(await mgr.getCredentials()).toEqual({ accessKey: 'ak', secretKey: 'sk' })
  })

  it('setCredentials 为空操作', async () => {
    const mgr = new EnvCredentialsManager({ token: 't1' })
    await mgr.setCredentials({ token: 't2' })
    expect(await mgr.getCredentials()).toEqual({ token: 't1' })
  })

  it('clearCredentials 为空操作', async () => {
    const mgr = new EnvCredentialsManager({ token: 't1' })
    await mgr.clearCredentials()
    expect(await mgr.getCredentials()).toEqual({ token: 't1' })
  })
})

// ── 凭证供应器 ────────────────────────────────────────

describe('EmptyCheckProvider', () => {
  it('空对象时触发 acquire', async () => {
    let called = false
    const p = new EmptyCheckProvider(async () => {
      called = true
      return { token: 'new' }
    })
    expect(p.needsRefresh({} as any)).toBe(true)
    expect(p.needsRefresh({ token: '' })).toBe(true)
    expect(p.needsRefresh({ token: 'abc' })).toBe(false)
    const creds = await p.acquire()
    expect(called).toBe(true)
    expect(creds).toEqual({ token: 'new' })
  })
})

describe('ExpiresAtProvider', () => {
  it('无 expiresAt 时需刷新', () => {
    const p = new ExpiresAtProvider<{ accessToken: string; expiresAt?: number }>({
      acquire: async () => ({ accessToken: '' }),
    })
    expect(p.needsRefresh({ accessToken: 't' })).toBe(true)
  })

  it('未过期的不用刷新', () => {
    const p = new ExpiresAtProvider<{ accessToken: string; expiresAt?: number }>({
      acquire: async () => ({ accessToken: '' }),
    })
    const far = { accessToken: 't', expiresAt: Date.now() + 3600_000 }
    expect(p.needsRefresh(far)).toBe(false)
  })

  it('即将过期时需要刷新', () => {
    const p = new ExpiresAtProvider<{ accessToken: string; expiresAt?: number }>({
      acquire: async () => ({ accessToken: '' }),
    })
    const soon = { accessToken: 't', expiresAt: Date.now() + 30_000 }
    expect(p.needsRefresh(soon)).toBe(true)
  })

  it('acquire 调用传入函数', async () => {
    let called = false
    const p = new ExpiresAtProvider<{ accessToken: string; expiresAt?: number }>({
      acquire: async () => {
        called = true
        return { accessToken: 'new' }
      },
    })
    const creds = await p.acquire()
    expect(called).toBe(true)
    expect(creds.accessToken).toBe('new')
  })

  it('有 refresh 时走 refresh', async () => {
    const p = new ExpiresAtProvider<{ accessToken: string; expiresAt?: number }>({
      acquire: async () => ({ accessToken: 'acquired' }),
      refresh: async (c) => ({ ...c, accessToken: 'refreshed' }),
    })
    const creds = await p.refresh({ accessToken: 'old' })
    expect(creds.accessToken).toBe('refreshed')
  })
})

// ── HttpClient request 流程 ─────────────────────────

describe('HttpClient 请求流程', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  /** 构造一个 JSON Response */
  function jsonResponse(body: any, status = 200) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  /** stub 全局 fetch，默认返回 { code: 0, data: { ok: true } } */
  function mockFetch(
    handler?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  ) {
    const fn = vi.fn(handler ?? (async () => jsonResponse({ code: 0, data: { ok: true } })))
    vi.stubGlobal('fetch', fn)
    return fn
  }

  function createClient(
    options: Partial<HttpClientOptions<any>> = {},
    fetchHandler?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  ) {
    // 默认不真的发请求；可传入自定义 handler
    mockFetch(fetchHandler)
    return new HttpClient({
      baseUrl: 'https://api.test',
      credentialsManager: new MemoryCredentialsManager(),
      authStrategy: new BearerTokenStrategy(),
      ...options,
    })
  }

  it('无 provider 时凭证为空抛 ApiError', async () => {
    const client = createClient()
    try {
      await (client as any).request({ method: 'POST', url: '/test' })
      expect.unreachable('应抛出异常')
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError)
      expect((e as ApiError).code).toBe(ApiErrorCodes.Unauthorized)
    }
  })

  it('有 provider + 空凭证时自动 acquire', async () => {
    let acquireCount = 0
    const client = createClient({
      credentialProvider: {
        acquire: async () => {
          acquireCount++
          return { token: 'acquired' }
        },
        needsRefresh: (c) => !c.token,
      },
    })
    const res = await (client as any).request({ method: 'POST', url: '/test' })
    expect(acquireCount).toBe(1)
    expect(res.data.ok).toBe(true)
  })

  it('有 provider + 有效凭证不走 acquire', async () => {
    let acquireCount = 0
    const mgr = new MemoryCredentialsManager({ token: 'valid' })
    const client = createClient({
      credentialsManager: mgr,
      credentialProvider: {
        acquire: async () => {
          acquireCount++
          return { token: 'acquired' }
        },
        needsRefresh: (c) => !c.token,
      },
    })
    const res = await (client as any).request({ method: 'POST', url: '/test' })
    expect(acquireCount).toBe(0)
    expect(res.data.ok).toBe(true)
  })

  it('有 provider + needsRefresh 返回 false 时不刷新', async () => {
    let acquireCount = 0
    const client = createClient({
      credentialProvider: {
        acquire: async () => {
          acquireCount++
          return { token: 'x' }
        },
        needsRefresh: () => false,
      },
    })
    try {
      await (client as any).request({ method: 'POST', url: '/test' })
      expect.unreachable('应抛出异常')
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError)
      expect((e as ApiError).code).toBe(ApiErrorCodes.Unauthorized)
    }
    expect(acquireCount).toBe(0)
  })

  it('并发 acquire 去重', async () => {
    let acquireCount = 0
    const client = createClient({
      credentialProvider: {
        acquire: async () => {
          acquireCount++
          await new Promise((r) => setTimeout(r, 50))
          return { token: 'acquired' }
        },
        needsRefresh: (c) => !c.token,
      },
    })
    // 用不同的 url 避免 abortMap 去重干扰
    await Promise.all([
      (client as any).request({ method: 'POST', url: '/test-a' }),
      (client as any).request({ method: 'POST', url: '/test-b' }),
    ])
    expect(acquireCount).toBe(1)
  })

  it('skipAuth 不触发 provider', async () => {
    let acquireCalled = false
    const client = createClient({
      credentialProvider: {
        acquire: async () => {
          acquireCalled = true
          return { token: 'x' }
        },
      },
    })
    await (client as any).request({ method: 'POST', url: '/test' }, { skipAuth: true })
    expect(acquireCalled).toBe(false)
  })

  it('HTTP 401 且可刷新时刷新凭证并重试一次', async () => {
    let calls = 0
    const client = createClient(
      {
        credentialsManager: new MemoryCredentialsManager({ token: 'valid' }),
        credentialProvider: {
          acquire: async () => ({ token: 'valid' }),
          refresh: async () => ({ token: 'refreshed' }),
          needsRefresh: () => false,
        },
      },
      async () => {
        calls++
        if (calls === 1) return jsonResponse({ message: '未授权' }, 401)
        return jsonResponse({ code: 0, data: { ok: true } })
      },
    )
    const res = await (client as any).request({ method: 'POST', url: '/test' })
    expect(calls).toBe(2)
    expect(res.data.ok).toBe(true)
    expect(await client.credentialsManager.getCredentials()).toEqual({
      token: 'refreshed',
    })
  })

  it('HTTP 401 且不可刷新时抛 Unauthorized，不重试', async () => {
    const client = createClient(
      {
        credentialsManager: new MemoryCredentialsManager({ token: 'valid' }),
        credentialProvider: {
          acquire: async () => ({ token: 'valid' }),
          needsRefresh: () => false,
        },
      },
      async () => jsonResponse({ message: '未授权' }, 401),
    )
    await expect((client as any).request({ method: 'POST', url: '/test' })).rejects.toMatchObject({
      code: ApiErrorCodes.Unauthorized,
      status: 401,
    })
  })

  it('网络异常映射为 NetworkError', async () => {
    const client = createClient(
      {
        credentialsManager: new MemoryCredentialsManager({ token: 'valid' }),
      },
      async () => {
        throw new TypeError('fetch failed')
      },
    )
    await expect((client as any).request({ method: 'POST', url: '/test' })).rejects.toMatchObject({
      code: ApiErrorCodes.NetworkError,
    })
  })

  it('HTTP 非 2xx 映射为对应 ApiError', async () => {
    const client = createClient(
      {
        credentialsManager: new MemoryCredentialsManager({ token: 'valid' }),
      },
      async () => jsonResponse({ message: '服务器开小差了' }, 500),
    )
    await expect((client as any).request({ method: 'POST', url: '/test' })).rejects.toMatchObject({
      code: ApiErrorCodes.InternalError,
      status: 500,
    })
  })

  // ── buildUrl URL 拼接 ────────────────────────────────

  function createClientWithFetch(
    baseUrl: string,
    fetchHandler: (input: RequestInfo | URL) => Promise<Response>,
  ) {
    const fetchFn = vi.fn(fetchHandler)
    vi.stubGlobal('fetch', fetchFn)
    return {
      client: new HttpClient({
        baseUrl,
        credentialsManager: new MemoryCredentialsManager({ token: 'valid' }),
        authStrategy: new BearerTokenStrategy(),
      }),
      fetchFn,
    }
  }

  async function getUrl(
    baseUrl: string,
    config: { url: string; params?: Record<string, any> },
  ): Promise<string> {
    const { client, fetchFn } = createClientWithFetch(baseUrl, async () =>
      jsonResponse({ code: 0, data: { ok: true } }),
    )
    await (client as any).request({ method: 'GET', ...config })
    return String(fetchFn.mock.calls[0][0])
  }

  it('baseUrl 尾斜杠不会产生双斜杠', async () => {
    expect(await getUrl('https://api.test/', { url: '/test' })).toBe('https://api.test/test')
  })

  it('baseUrl 带 path 时请求路径拼接在其后', async () => {
    expect(await getUrl('https://api.test/api/v1', { url: '/users' })).toBe(
      'https://api.test/api/v1/users',
    )
  })

  it('baseUrl 带 path 且尾斜杠时不产生双斜杠', async () => {
    expect(await getUrl('https://api.test/api/v1/', { url: '/users' })).toBe(
      'https://api.test/api/v1/users',
    )
  })

  it('baseUrl 带 path 时 path 无前导斜杠同样拼接', async () => {
    expect(await getUrl('https://api.test/api/v1', { url: 'users' })).toBe(
      'https://api.test/api/v1/users',
    )
  })

  it('path 无前导斜杠时按根路径解析', async () => {
    expect(await getUrl('https://api.test', { url: 'test' })).toBe('https://api.test/test')
  })

  it('path 自带查询串时与 params 以 & 合并', async () => {
    expect(
      await getUrl('https://api.test', {
        url: '/users?id=1',
        params: { page: 2 },
      }),
    ).toBe('https://api.test/users?id=1&page=2')
  })

  it('params 过滤 undefined 与 null', async () => {
    expect(
      await getUrl('https://api.test', {
        url: '/list',
        params: { a: undefined, b: null, c: 1 },
      }),
    ).toBe('https://api.test/list?c=1')
  })

  it('params 数组展开为重复键', async () => {
    expect(
      await getUrl('https://api.test', {
        url: '/list',
        params: { ids: [1, 2] },
      }),
    ).toBe('https://api.test/list?ids=1&ids=2')
  })

  it('params 嵌套对象 JSON 序列化', async () => {
    expect(
      await getUrl('https://api.test', {
        url: '/list',
        params: { filter: { status: 'on' } },
      }),
    ).toBe('https://api.test/list?filter=%7B%22status%22%3A%22on%22%7D')
  })

  it('url 为完整 URL 时直接使用，不拼接 baseUrl', async () => {
    expect(
      await getUrl('https://api.test', {
        url: 'https://other.test/x',
        params: { page: 1 },
      }),
    ).toBe('https://other.test/x?page=1')
  })

  it('无 params 时不带查询串', async () => {
    expect(await getUrl('https://api.test', { url: '/test' })).toBe('https://api.test/test')
  })

  // ── 便捷方法 get / post / put / delete ─────────────────

  /** 构造可捕获请求的客户端：返回 client 与被 stub 的 fetch mock */
  function createCapturingClient(
    handler?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  ) {
    const fetchFn = mockFetch(handler)
    const client = new HttpClient({
      baseUrl: 'https://api.test',
      credentialsManager: new MemoryCredentialsManager({ token: 'valid' }),
      authStrategy: new BearerTokenStrategy(),
    })
    return { client, fetchFn }
  }

  it('get 发送 GET 并拼接查询参数', async () => {
    const { client, fetchFn } = createCapturingClient()
    const res = await client.get<{ ok: boolean }>('/users', { page: 2 })
    expect(res.ok).toBe(true)
    const [url, init] = fetchFn.mock.calls[0]
    expect(init?.method).toBe('GET')
    expect(String(url)).toBe('https://api.test/users?page=2')
    expect(init?.body).toBeUndefined()
  })

  it('post 发送 POST 并序列化 JSON body', async () => {
    const { client, fetchFn } = createCapturingClient()
    const res = await client.post<{ ok: boolean }>('/users', { name: '张三' })
    expect(res.ok).toBe(true)
    const [url, init] = fetchFn.mock.calls[0]
    expect(init?.method).toBe('POST')
    expect(String(url)).toBe('https://api.test/users')
    expect(init?.body).toBe(JSON.stringify({ name: '张三' }))
  })

  it('put 发送 PUT 并携带 body', async () => {
    const { client, fetchFn } = createCapturingClient()
    const res = await client.put<{ ok: boolean }>('/users/1', { name: '李四' })
    expect(res.ok).toBe(true)
    const [url, init] = fetchFn.mock.calls[0]
    expect(init?.method).toBe('PUT')
    expect(String(url)).toBe('https://api.test/users/1')
    expect(init?.body).toBe(JSON.stringify({ name: '李四' }))
  })

  it('delete 发送 DELETE 并拼接查询参数', async () => {
    const { client, fetchFn } = createCapturingClient()
    const res = await client.delete<{ ok: boolean }>('/users/1', { hard: true })
    expect(res.ok).toBe(true)
    const [url, init] = fetchFn.mock.calls[0]
    expect(init?.method).toBe('DELETE')
    expect(String(url)).toBe('https://api.test/users/1?hard=true')
  })

  it('业务错误 code !== 0 时解包抛 ApiError', async () => {
    const { client } = createCapturingClient(async () =>
      jsonResponse({ code: 2001, message: '用户不存在' }),
    )
    await expect(client.get('/users/1')).rejects.toMatchObject({
      code: ApiErrorCodes.NotFound,
    })
  })
})
