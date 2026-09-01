'use client'

import { Button } from '@repo/ui'
import { HomeIcon } from 'lucide-react'
import Link from 'next/link'
import { Pages } from '@/lib/constants'

export default function Forbidden() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <div className="flex flex-col items-center gap-4 text-center">
        <div className="font-mono text-6xl font-semibold tracking-tight">403</div>
        <p className="text-sm text-muted-foreground">
          抱歉，您没有权限访问该页面。
        </p>
        <Button render={<Link href={Pages.dashboard} />}>
          <HomeIcon />
          回到首页
        </Button>
      </div>
    </div>
  )
}
