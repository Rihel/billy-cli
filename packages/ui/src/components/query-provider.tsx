'use client'

import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useState, type ReactNode } from 'react'

import { toastError } from '#components/toast'

/**
 * TanStack Query 的装配（机制 + 策略透传）。
 *
 * 机制（各前端一致）：QueryCache / MutationCache 的 `onError` 统一 toast —— 错误不静默；
 * 策略（各前端可能不同）：`staleTime` / `refetchOnWindowFocus` / 兜底文案由调用方传入，
 * 本文件不替应用做缓存决策。
 */
export type QueryClientOptions = {
  /** 数据在多久内视为新鲜（ms）。不传则用 TanStack 默认（0，视为立即过期） */
  staleTime?: number
  /** 窗口重新聚焦时是否重新请求，默认 false（避免切回窗口就刷一遍） */
  refetchOnWindowFocus?: boolean
  /** 错误兜底文案（错误对象没有可用 message 时展示） */
  fallbackError?: string
}

function errorMessage(error: unknown, fallbackError: string) {
  return error instanceof Error && error.message ? error.message : fallbackError
}

/** 建一个「错误统一提示」的 QueryClient；策略由 options 决定 */
export function createQueryClient(options: QueryClientOptions = {}) {
  const {
    staleTime,
    refetchOnWindowFocus = false,
    fallbackError = '操作失败，请稍后重试',
  } = options

  const onError = (error: unknown) => toastError(errorMessage(error, fallbackError))

  return new QueryClient({
    queryCache: new QueryCache({ onError }),
    mutationCache: new MutationCache({ onError }),
    defaultOptions: {
      queries: { staleTime, refetchOnWindowFocus },
    },
  })
}

export type QueryProvidersProps = QueryClientOptions & {
  children: ReactNode
}

/** QueryClient + Provider 的装配组件（每个前端在根 layout 挂一次） */
export function QueryProviders({ children, ...options }: QueryProvidersProps) {
  // useState 惰性初始化：客户端实例只建一次（客户端也装不了新 QueryClient，否则缓存全丢）
  const [client] = useState(() => createQueryClient(options))

  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}
