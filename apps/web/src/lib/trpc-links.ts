import type { AppRouter } from '@app/server/src/@generated/server'
import { type TRPCLink } from '@trpc/client'
import { observable } from '@trpc/server/observable'

export function unauthorizedLink(
  onUnauthorized: () => void,
): TRPCLink<AppRouter> {
  return () =>
    ({ next, op }) =>
      observable((observer) =>
        next(op).subscribe({
          next: observer.next.bind(observer),
          complete: observer.complete.bind(observer),
          error(err) {
            if ((err as any)?.data?.code === 'UNAUTHORIZED') {
              onUnauthorized()
            }
            observer.error(err)
          },
        }),
      )
}
