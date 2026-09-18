import { cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  StorageClientProvider,
  type PresignedUploadClientLike,
} from '../src/components/storage-client-provider.tsx'
import { useStorageAdapter } from '../src/components/storage-provider.tsx'
import { createQueryClient } from '../src/components/query-provider.tsx'
import { RouteError } from '../src/components/route-error.tsx'
import { RouteNotFound } from '../src/components/route-not-found.tsx'

/**
 * 应用装配组件（StorageClientProvider / QueryProviders / 路由兜底）的契约。
 *
 * 这几件事原先在 web / admin 各有一份，测试要盯住的是**被抽出来的机制**：
 * 预签名入参形状、Query 缓存是否挂了统一错误处理、策略是否真的透传。
 *
 * 注：`@repo/ui` 的 vitest 没开 `globals`，RTL 的自动清理不会生效 ——
 * 本文件会重复渲染同一套版式，故显式 `cleanup`（否则 `getByRole` 会撞到上一次的 DOM）。
 */
afterEach(cleanup)

describe('StorageClientProvider', () => {
  it('把 storage.getPresignedUrl({ key }) 暴露给上传组件（入参形状是契约）', async () => {
    const getPresignedUrl = vi.fn(async ({ key }: { key: string }) => ({
      key,
      url: `https://cdn.test/${key}`,
    }))
    const client: PresignedUploadClientLike = {
      storage: { getPresignedUrl },
    }

    const { result } = renderHook(() => useStorageAdapter(), {
      wrapper: ({ children }) => (
        <StorageClientProvider client={client} resolveUrl={(key) => `u:${key}`}>
          {children}
        </StorageClientProvider>
      ),
    })

    await expect(result.current.getPresignedUpload('avatar/a.png')).resolves.toEqual(
      { key: 'avatar/a.png', url: 'https://cdn.test/avatar/a.png' },
    )
    expect(getPresignedUrl).toHaveBeenCalledWith({ key: 'avatar/a.png' })
  })

  it('resolveUrl 原样透传（key → URL 的规则由应用决定）', () => {
    const client: PresignedUploadClientLike = {
      storage: { getPresignedUrl: vi.fn() },
    }

    const { result } = renderHook(() => useStorageAdapter(), {
      wrapper: ({ children }) => (
        <StorageClientProvider client={client} resolveUrl={(key) => `u:${key}`}>
          {children}
        </StorageClientProvider>
      ),
    })

    expect(result.current.resolveUrl('a.png')).toBe('u:a.png')
  })
})

describe('createQueryClient', () => {
  it('策略由调用方注入（staleTime 透传，窗口聚焦默认不重取）', () => {
    const client = createQueryClient({ staleTime: 1234 })
    const queries = client.getDefaultOptions().queries

    expect(queries?.staleTime).toBe(1234)
    expect(queries?.refetchOnWindowFocus).toBe(false)
  })

  it('query 与 mutation 两条缓存都挂了 onError（错误不静默）', () => {
    const client = createQueryClient()
    // config 的类型是私有的，这里只断言「有挂上错误处理」这一事实
    const queryCache = client.getQueryCache() as unknown as {
      config?: { onError?: unknown }
    }
    const mutationCache = client.getMutationCache() as unknown as {
      config?: { onError?: unknown }
    }

    expect(typeof queryCache.config?.onError).toBe('function')
    expect(typeof mutationCache.config?.onError).toBe('function')
  })
})

describe('路由兜底版式', () => {
  it('RouteError 渲染标题 / 描述 / digest，重试按钮回调可用', () => {
    const reset = vi.fn()
    const error = Object.assign(new Error('boom'), { digest: 'abc123' })

    render(<RouteError error={error} reset={reset} showDigest />)

    expect(screen.getByText('出错了')).toBeTruthy()
    expect(screen.getByText('digest: abc123')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /重试/ }))
    expect(reset).toHaveBeenCalledTimes(1)
  })

  it('RouteError 不传 reset 时不渲染重试按钮（后台主区用附加动作代替）', () => {
    render(<RouteError title="页面加载失败" action={<a href="/">回到首页</a>} />)

    expect(screen.queryByRole('button', { name: /重试/ })).toBeNull()
    expect(screen.getByRole('link', { name: '回到首页' })).toBeTruthy()
  })

  it('RouteNotFound 用 404 版式，动作区由 app 传入（组件库不依赖 Next）', () => {
    render(<RouteNotFound action={<a href="/">回到首页</a>} />)

    expect(screen.getByText('404')).toBeTruthy()
    expect(screen.getByRole('link', { name: '回到首页' })).toBeTruthy()
  })
})
