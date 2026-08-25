import { createServerClient } from '@/lib/server-client'
import { AuthStoreProvider } from '@/stores/auth.store'
import { redirect } from 'next/navigation'

import { ReactNode, Suspense } from 'react'
import { AppHeader } from '../../components/AppHeader'
import { AppSider } from '../../components/AppSider'
import { Pages, TokenKey } from '@/lib/constants'
import { cookies } from 'next/headers'

export const dynamic = 'force-dynamic'

export type MainLayoutProps = Partial<{
  children: ReactNode
}>

const MainLayout = async ({ children }: MainLayoutProps) => {
  let adminInfo: Record<string, any>
  const jar = await cookies()
  try {
    const client = createServerClient(jar.get(TokenKey)?.value)
    adminInfo = await client.admin.getMe()
  } catch {
    // 会话失效（过期 / 无效）时带 reason 跳转登录页，登录页据此提示重新登录
    redirect(`${Pages.login}?reason=expired`)
  }

  return (
    <AuthStoreProvider
      initialState={{
        adminInfo: adminInfo as any,
      }}
    >
      <div className="w-screen h-screen flex flex-col relative bg-gray-50">
        <AppHeader className="shrink-0" />
        <div className="flex flex-1 overflow-hidden">
          <AppSider />
          <div className=" flex-1 h-full   flex items-stretch">
            <div className="mr-4 mb-4 ml-2   bg-white overflow-hidden  w-full shadow rounded-xl">
              <Suspense>{children}</Suspense>
            </div>
          </div>
        </div>
      </div>
    </AuthStoreProvider>
  )
}

export default MainLayout
