'use client'

import { Button } from '@repo/ui'
import { RefreshCwIcon } from 'lucide-react'

/**
 * 路由级错误兜底（Next App Router 约定文件）。
 *
 * 必须显式提供：`force-dynamic` 下每个请求都真实执行服务端组件，任何一次后端不可用 / 渲染异常
 * 都会命中这里；没有它用户只会看到 Next 的默认错误页（英文、无重试入口）。
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-white px-4">
      <div className="flex flex-col items-center gap-4 text-center">
        <div className="text-5xl font-semibold tracking-tight text-zinc-900">
          出错了
        </div>
        <p className="text-sm text-zinc-500">
          页面加载失败，请稍后重试。
        </p>
        {error.digest ? (
          <p className="font-mono text-xs text-zinc-400">
            digest: {error.digest}
          </p>
        ) : null}
        <Button onClick={reset}>
          <RefreshCwIcon />
          重试
        </Button>
      </div>
    </div>
  )
}
