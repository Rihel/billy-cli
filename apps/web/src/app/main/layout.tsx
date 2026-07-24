import { serverTRPC } from '@/lib/server-trpc'
import { AuthStoreProvider } from '@/stores/auth.store'
import { Layout } from 'antd'
import { Content } from 'antd/es/layout/layout'

import { ReactNode } from 'react'
import { AppHeader } from './_components/AppHeader'
import { AppSider } from './_components/AppSider'

export const dynamic = 'force-dynamic'

export type MainLayoutProps = Partial<{
  children: ReactNode
}>

const MainLayout = async ({ children }: MainLayoutProps) => {
  const res = await serverTRPC.auth.getMe.query()

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
          <Content>{children}</Content>
        </Layout>
      </Layout>
    </AuthStoreProvider>
  )
}

export default MainLayout
