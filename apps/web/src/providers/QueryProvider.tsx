'use client'

import {
  MutationCache,
  QueryCache,
  QueryClient,
  QueryClientProvider,
} from '@tanstack/react-query'
import { toastError } from '@repo/ui'
import { useState } from 'react'

/** 请求失败统一提示（与 admin 的 `AppProviders` 同一策略：错误不静默） */
function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return '操作失败，请稍后重试'
}

export function QueryProvider({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        queryCache: new QueryCache({
          onError: (error) => void toastError(getErrorMessage(error)),
        }),
        mutationCache: new MutationCache({
          onError: (error) => void toastError(getErrorMessage(error)),
        }),
        defaultOptions: {
          queries: {
            staleTime: 60 * 1000,
            refetchOnWindowFocus: false,
          },
        },
      }),
  )

  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
}
