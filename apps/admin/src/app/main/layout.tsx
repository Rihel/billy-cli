import { createServerClient } from '@/lib/server-client'
import { AuthStoreProvider } from '@/stores/auth.store'
import { redirect } from 'next/navigation'

import { ReactNode, Suspense } from 'react'
import { SidebarInset, SidebarProvider } from '@repo/ui'
import { AppHeader } from '../../components/AppHeader'
import { AppSider } from '../../components/AppSider'
import { Pages, TokenKey } from '@/lib/constants'
import { cookies } from 'next/headers'

export const dynamic = 'force-dynamic'

export type MainLayoutProps = Partial<{
  children: ReactNode
}>

const MainLayout = async ({ children }: MainLayoutProps) => {
  // 用户体系开关：调后端 /config/get 获取（关闭时跳过 getMe，自用 / 外部认证场景）
  // 获取失败时保守按「开启」处理（保持现有守卫行为）
  let authEnabled = true
  try {
    const config = await createServerClient().config.get()
    authEnabled = config.authEnabled
  } catch {
    // 保持默认开启
  }

  let adminInfo: Record<string, any> | null = null
  if (authEnabled) {
    const jar = await cookies()
    try {
      const client = createServerClient(jar.get(TokenKey)?.value)
      adminInfo = await client.admin.getMe()
    } catch {
      // 会话失效（过期 / 无效）时带 reason 跳转登录页，登录页据此提示重新登录
      redirect(`${Pages.login}?reason=expired`)
    }
  }

  return (
    <AuthStoreProvider
      initialState={{
        adminInfo: adminInfo as any,
        authEnabled,
      }}
    >
      <div className="relative flex h-screen w-screen overflow-hidden bg-background">
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
    </AuthStoreProvider>
  )
}

export default MainLayout
