'use client'

import { Button } from '@repo/ui'
import { RefreshCwIcon } from 'lucide-react'

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <div className="flex flex-col items-center gap-4 text-center">
        <div className="text-5xl font-semibold">出错了</div>
        <p className="text-sm text-muted-foreground">
          服务器发生了一些问题，请稍后重试。
        </p>
        <Button onClick={reset}>
          <RefreshCwIcon />
          重试
        </Button>
      </div>
    </div>
  )
}
