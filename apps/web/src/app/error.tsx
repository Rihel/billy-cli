'use client'

import { RouteError } from '@repo/ui'

/**
 * 路由级错误兜底（Next App Router 约定文件，文件必须在位）。
 * 版式在 `@repo/ui` 的 `RouteError`；前台多展示 `digest` 便于用户报障。
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  return <RouteError error={error} reset={reset} showDigest />
}
