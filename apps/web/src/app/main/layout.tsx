import { createServerClientFromCookies } from '@/lib/server-client'
import { AuthStoreProvider } from '@/stores/auth.store'
import { redirect } from 'next/navigation'

import { ReactNode, Suspense } from 'react'
import { AppHeader } from '../../components/AppHeader'
import { AppSider } from '../../components/AppSider'
import { Pages } from '@/lib/constants'

export const dynamic = 'force-dynamic'

export type MainLayoutProps = Partial<{
  children: ReactNode
}>

const MainLayout = async ({ children }: MainLayoutProps) => {
  let userInfo: Record<string, any>
  try {
    const client = await createServerClientFromCookies()
    userInfo = await client.auth.getMe()
  } catch {
    redirect(Pages.login)
  }

  return (
    <AuthStoreProvider
      initialState={{
        userInfo: userInfo as any,
      }}
    >
      <div className="w-screen h-screen flex flex-col">
        <AppHeader />
        <div className="flex flex-1">
          <AppSider />
          <div className="bg-gray-50 flex-1">
            <div className="m-5 p-5 bg-white">
              <Suspense>{children}</Suspense>
            </div>
          </div>
        </div>
      </div>
    </AuthStoreProvider>
  )
}

export default MainLayout
