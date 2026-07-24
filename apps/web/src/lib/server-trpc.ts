import type { AppRouter } from '@app/server/src/@generated/server'
import { createTRPCClient, httpBatchLink } from '@trpc/client'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { TokenKey, Pages } from './constants'
import { unauthorizedLink } from './trpc-links'

/**
 * Server-side tRPC client for use in Server Actions / Route Handlers.
 * Forwards the httpOnly cookie token as Authorization header so the backend
 * can authenticate the request.
 */
export const serverTRPC = createTRPCClient<AppRouter>({
  links: [
    unauthorizedLink(() => redirect(Pages.login)),
    httpBatchLink({
      url: process.env.SERVER_URL + '/trpc',
      async headers() {
        const jar = await cookies()
        const token = jar.get(TokenKey)?.value
        return token ? { Authorization: `Bearer ${token}` } : {}
      },
    }),
  ],
})
