import { serverTRPC } from '@/lib/server-trpc'
import { AuthStoreProvider } from '@/stores/auth.store'
import { Layout } from 'antd'
import { Content } from 'antd/es/layout/layout'
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
  let res: Awaited<ReturnType<typeof serverTRPC.auth.getMe.query>>
  try {
    res = await serverTRPC.auth.getMe.query()
  } catch {
    redirect(Pages.login)
  }

  return (
    <AuthStoreProvider
      initialState={{
        userInfo: res,
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
