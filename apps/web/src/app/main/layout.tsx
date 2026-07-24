import { serverTRPC } from '@/lib/server-trpc'
import { AuthStoreProvider } from '@/stores/auth.store'
import { Layout } from 'antd'
import { Content } from 'antd/es/layout/layout'
import { redirect } from 'next/navigation'

import { ReactNode, Suspense } from 'react'
import { AppHeader } from './_components/AppHeader'
import { AppSider } from './_components/AppSider'
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
      <Layout className="w-screen h-screen">
        <AppHeader />
        <Layout>
          <AppSider />
          <Content>
            <div className="m-5 p-5 bg-white">
              <Suspense>{children}</Suspense>
            </div>
          </Content>
        </Layout>
      </Layout>
    </AuthStoreProvider>
  )
}

export default MainLayout
