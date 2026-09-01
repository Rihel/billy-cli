'use client'

import { ReactNode, useRef } from 'react'
import {
  MutationCache,
  QueryCache,
  QueryClient,
  QueryClientProvider,
} from '@tanstack/react-query'
import { StorageProvider, toastError, Toaster, TooltipProvider } from '@repo/ui'
import { formatStorageUrl } from '@/lib/constants'
import { useServerClient } from '@/lib/server-client'

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return '操作失败，请稍后重试'
}

function AppStorageProvider({ children }: { children: ReactNode }) {
  const client = useServerClient()

  return (
    <StorageProvider
      getPresignedUpload={(key) => client.storage.getPresignedUrl({ key })}
      resolveUrl={formatStorageUrl}
    >
      {children}
    </StorageProvider>
  )
}

function QueryProviders({ children }: { children: ReactNode }) {
  const queryClient = useRef(
    new QueryClient({
      queryCache: new QueryCache({
        onError: (error) => void toastError(getErrorMessage(error)),
      }),
      mutationCache: new MutationCache({
        onError: (error) => void toastError(getErrorMessage(error)),
      }),
      defaultOptions: {
        queries: { refetchOnWindowFocus: false },
      },
    }),
  )

  return (
    <QueryClientProvider client={queryClient.current}>
      {children}
    </QueryClientProvider>
  )
}

export type ProvidersProps = Partial<{
  children: ReactNode
}>

export const Providers = ({ children }: ProvidersProps) => {
  return (
    <TooltipProvider>
      <QueryProviders>
        <AppStorageProvider>{children}</AppStorageProvider>
      </QueryProviders>
      <Toaster />
    </TooltipProvider>
  )
}
