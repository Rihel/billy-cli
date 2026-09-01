'use client'

import { Button } from '@repo/ui'
import { useRouter } from 'next/navigation'
import { HomeIcon, RefreshCwIcon } from 'lucide-react'
import { Pages } from '@/lib/constants'

export default function MainError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  const router = useRouter()

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/40">
      <div className="flex flex-col items-center gap-4 text-center">
        <div className="text-5xl font-semibold">页面加载失败</div>
        <p className="text-sm text-muted-foreground">
          加载数据时遇到问题，请重试或返回首页。
        </p>
        <div className="flex gap-2">
          <Button onClick={reset}>
            <RefreshCwIcon />
            重试
          </Button>
          <Button variant="outline" onClick={() => router.replace(Pages.dashboard)}>
            <HomeIcon />
            回到首页
          </Button>
        </div>
      </div>
    </div>
  )
}
