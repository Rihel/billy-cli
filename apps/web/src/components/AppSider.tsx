'use client'

import { Layout } from 'antd'

import { AppMenu } from './AppMenu'
import { useLayoutStore } from '@/stores/layout.store'

const { Sider } = Layout

export type AppSiderProps = Partial<{}>

export const AppSider = ({}: AppSiderProps) => {
  const { isSiderCollapsed } = useLayoutStore()
  return (
    <Sider
      collapsed={isSiderCollapsed}
      theme="light"
      classNames={{
        root: 'h-full !bg-transparent',
        body: 'bg-transparent',
      }}
      width={240}
    >
      <AppMenu />
    </Sider>
  )
}
