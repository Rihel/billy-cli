"use client"

import { RefreshCwIcon } from "lucide-react"
import type { ReactNode } from "react"

import { Button } from "#components/ui/button"

export type RouteErrorProps = {
  /** Next 注入的路由级错误（`app/error.tsx` 的入参） */
  error?: Error & { digest?: string }
  /** Next 注入的重试函数（`app/error.tsx` 的入参）；传了才渲染「重试」按钮 */
  reset?: () => void
  title?: string
  description?: string
  /** 附加动作（如「回到首页」按钮），与重试按钮同一行 */
  action?: ReactNode
  /** 是否展示 `digest`（服务端错误的定位标识；前台默认展示便于用户报障，后台不展示） */
  showDigest?: boolean
}

/**
 * 路由级错误兜底的版式（`app/error.tsx` 用它，文件本身只留一行壳）。
 *
 * 必须显式提供：两个前端都是 `force-dynamic`，每个请求都真实执行服务端组件，
 * 后端不可用 / 渲染异常都会命中这里；没有它用户只会看到 Next 的英文默认错误页。
 * 视觉取值走语义 token（写死白底 / 调色板色阶会丢掉暗色能力）。
 */
export function RouteError({
  error,
  reset,
  title = "出错了",
  description = "页面加载失败，请稍后重试。",
  action,
  showDigest = false,
}: RouteErrorProps) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="flex flex-col items-center gap-4 text-center">
        <div className="text-5xl font-semibold tracking-tight text-foreground">
          {title}
        </div>
        <p className="text-sm text-muted-foreground">{description}</p>
        {showDigest && error?.digest ? (
          <p className="font-mono text-xs text-muted-foreground">
            digest: {error.digest}
          </p>
        ) : null}
        {reset || action ? (
          <div className="flex gap-2">
            {reset ? (
              <Button onClick={reset}>
                <RefreshCwIcon />
                重试
              </Button>
            ) : null}
            {action}
          </div>
        ) : null}
      </div>
    </div>
  )
}
