import Link from 'next/link'
import { HomeIcon } from 'lucide-react'
import { Button, RouteNotFound } from '@repo/ui'
import { Pages } from '@/lib/constants'

/** 路由级 404 兜底（Next 约定文件）；版式在 `@repo/ui` 的 `RouteNotFound` */
export default function NotFound() {
  return (
    <RouteNotFound
      action={
        <Button nativeButton={false} render={<Link href={Pages.home} />}>
          <HomeIcon />
          回到首页
        </Button>
      }
    />
  )
}
