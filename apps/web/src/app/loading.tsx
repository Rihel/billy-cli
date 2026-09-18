import { PageLoading } from '@repo/ui'

/** 路由级加载态（`force-dynamic` 下每次导航都走服务端渲染，首屏等待需要可见反馈） */
export default function Loading() {
  return <PageLoading fullscreen className="bg-background" />
}
