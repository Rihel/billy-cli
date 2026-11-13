'use client'

import { RouteError } from '@repo/ui'

/** 根级错误兜底（Next 约定文件，文件必须在位）；版式在 `@repo/ui` 的 `RouteError` */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  return <RouteError error={error} reset={reset} description="服务器发生了一些问题，请稍后重试。" />
}
