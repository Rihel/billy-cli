'use client'

import { App, ConfigProvider } from 'antd'
import { ReactNode, useRef } from 'react'
import zhCN from 'antd/locale/zh_CN'
import {
  MutationCache,
  QueryCache,
  QueryClient,
  QueryClientProvider,
} from '@tanstack/react-query'
import { createTRPCClient, TRPCProvider } from '@/lib/client-trpc'

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return '操作失败，请稍后重试'
}

/** 必须在 <App> 内部才能拿到主题感知的 message 实例 */
function QueryProviders({ children }: { children: ReactNode }) {
  const { message } = App.useApp()

  const queryClient = useRef(
    new QueryClient({
      queryCache: new QueryCache({
        onError: (error) => void message.error(getErrorMessage(error)),
      }),
      mutationCache: new MutationCache({
        onError: (error) => void message.error(getErrorMessage(error)),
      }),
      defaultOptions: {
        queries: { refetchOnWindowFocus: false },
      },
    }),
  )

  const trpcClient = useRef(createTRPCClient())

  return (
    <QueryClientProvider client={queryClient.current}>
      <TRPCProvider
        trpcClient={trpcClient.current}
        queryClient={queryClient.current}
      >
        {children}
      </TRPCProvider>
    </QueryClientProvider>
  )
}

export type ProvidersProps = Partial<{
  children: ReactNode
}>

export const Providers = ({ children }: ProvidersProps) => {
  return (
    <ConfigProvider
      locale={zhCN}
      variant="filled"
      form={{
        validateMessages: {
          required: '${label}不能为空',
        },
      }}
    >
      <App>
        <QueryProviders>{children}</QueryProviders>
      </App>
    </ConfigProvider>
  )
}
