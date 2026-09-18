'use client'

import { Button, RouteNotFound } from '@repo/ui'
import { HomeIcon } from 'lucide-react'
import Link from 'next/link'
import { Pages } from '@/lib/constants'

/** 403 无权限页（`authInterrupts` 的 `forbidden()` 触发）；与 404 同一版式，仅标题 / 文案不同 */
export default function Forbidden() {
  return (
    <RouteNotFound
      title="403"
      description="抱歉，您没有权限访问该页面。"
      action={
        <Button render={<Link href={Pages.dashboard} />}>
          <HomeIcon />
          回到首页
        </Button>
      }
    />
  )
}
