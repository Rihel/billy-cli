'use client'

import { Button, RouteNotFound } from '@repo/ui'
import { HomeIcon } from 'lucide-react'
import Link from 'next/link'
import { Pages } from '@/lib/constants'

/** 路由级 404 兜底（Next 约定文件）；版式在 `@repo/ui` 的 `RouteNotFound` */
export default function NotFound() {
  return (
    <RouteNotFound
      description="抱歉，您访问的页面不存在。"
      action={
        <Button render={<Link href={Pages.dashboard} />}>
          <HomeIcon />
          回到首页
        </Button>
      }
    />
  )
}
