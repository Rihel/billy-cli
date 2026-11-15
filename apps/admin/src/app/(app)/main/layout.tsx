import { Suspense } from 'react'
import type { ReactNode } from 'react'
import { SidebarInset, SidebarProvider } from '@repo/ui'
import { AdminAuthBoundary } from '../../../components/AdminAuthBoundary'
import { AppHeader } from '../../../components/AppHeader'
import { AppSider } from '../../../components/AppSider'
import { AppTopBar } from '../../../components/AppTopBar'

export const dynamic = 'force-dynamic'

export type MainLayoutProps = Partial<{
  children: ReactNode
}>

/**
 * **管理台外壳**：全局顶栏 + 左侧菜单 + 分区页头 + 内容区（三棵布局树共用同一条顶栏）。
 *
 * 竖排三段：顶栏（会话 / 管理切换、品牌、账号）**横贯整个窗口**，下面才是「侧栏 + 内容」——
 * 顶栏不跟着侧栏一起被挤到右边，切换顶层分区时它原地不动，位置稳定。
 * 共享 `Sidebar` 的容器是 `fixed`，所以它在 `AppSider` 里按顶栏高度整体下移（见那里的注释）。
 *
 * 鉴权与身份注入抽在 `AdminAuthBoundary` 里（`app/(standalone)/main/layout.tsx` 也用同一份）——
 * 两棵布局树各有各的外壳，但**守卫只有一份实现**。
 *
 * 例外：`/main/ai/chat/**` 不走这里（它是独立布局，见 `app/(standalone)/main/layout.tsx`）——
 * 会话页是"全窗口工作台"，不需要左侧菜单与分区页头；它仍然共用同一条顶栏，
 * 所以「切回管理」在会话页上永远看得见。
 */
const MainLayout = async ({ children }: MainLayoutProps) => (
  <AdminAuthBoundary>
    <div className="relative flex h-dvh w-screen flex-col overflow-hidden bg-background">
      <AppTopBar />
      <SidebarProvider className="min-h-0 min-w-0 flex-1">
        <AppSider />
        {/* 内容区：嵌入式（与侧栏同底连续，无漂浮面板） */}
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
