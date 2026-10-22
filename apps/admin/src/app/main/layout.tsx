import { Suspense } from 'react'
import type { ReactNode } from 'react'
import { SidebarInset, SidebarProvider } from '@repo/ui'
import { AdminAuthBoundary } from '../../components/AdminAuthBoundary'
import { AppHeader } from '../../components/AppHeader'
import { AppSider } from '../../components/AppSider'

export const dynamic = 'force-dynamic'

export type MainLayoutProps = Partial<{
  children: ReactNode
}>

/**
 * **管理台外壳**：左侧菜单 + 页头 + 内容区。
 *
 * 鉴权与身份注入抽在 `AdminAuthBoundary` 里（`app/(standalone)/main/layout.tsx` 也用同一份）——
 * 两棵布局树各有各的外壳，但**守卫只有一份实现**。
 *
 * 例外：`/main/ai/chat/**` 不走这里（它是独立布局，见 `app/(standalone)/main/layout.tsx`）——
 * 会话页是"全窗口工作台"，套两层壳会白送竖直空间。
 */
const MainLayout = async ({ children }: MainLayoutProps) => (
  <AdminAuthBoundary>
    <div className="relative flex h-dvh w-screen overflow-hidden bg-background">
      <SidebarProvider>
        <AppSider />
        {/* 内容区：嵌入式（与侧栏同底连续，无漂浮面板；顶栏 hairline 分隔） */}
        <SidebarInset className="overflow-hidden">
          <AppHeader className="shrink-0" />
          <main className="min-w-0 flex-1 overflow-hidden">
            <Suspense>{children}</Suspense>
          </main>
        </SidebarInset>
      </SidebarProvider>
    </div>
  </AdminAuthBoundary>
)

export default MainLayout
