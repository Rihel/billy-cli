'use client'

import { Button, RouteError } from '@repo/ui'
import { useRouter } from 'next/navigation'
import { HomeIcon } from 'lucide-react'
import { Pages } from '@/lib/constants'

/** 后台主区错误兜底：除重试外还给一条「回到工作台」的退路（版式在 `@repo/ui`） */
export default function MainError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  const router = useRouter()

  return (
    <RouteError
      error={error}
      reset={reset}
      title="页面加载失败"
      description="加载数据时遇到问题，请重试或返回首页。"
      action={
        <Button
          variant="outline"
          onClick={() => router.replace(Pages.dashboard)}
        >
          <HomeIcon />
          回到首页
        </Button>
      }
    />
  )
}
