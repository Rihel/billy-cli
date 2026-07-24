import type { AppRouter } from '@app/server/src/@generated/server'
import { createTRPCContext } from '@trpc/tanstack-react-query'
import { createTRPCClient as createClient, httpBatchLink } from '@trpc/client'
import { authStorage } from './auth'

export const { TRPCProvider, useTRPC, useTRPCClient } =
  createTRPCContext<AppRouter>()

export const createTRPCClient = () => {
  return createClient<AppRouter>({
    links: [
      httpBatchLink({
        url: process.env.NEXT_PUBLIC_SERVER_URL + '/trpc',
        headers() {
          const token = authStorage.getToken()
          return token ? { Authorization: `Bearer ${token}` } : {}
        },
      }),
    ],
  })
}
