'use client'

import { AppName, formatStorageUrl } from '@/lib/constants'
import { useAuthStore } from '@/stores/auth.store'
import { logoutAction } from '@/actions/auth.actions'
import { removeToken } from '@/lib/server-client'
import { DownOutlined } from '@ant-design/icons'
import { Avatar, Dropdown } from 'antd'
import type { MenuProps } from 'antd'
import { useRouter } from 'next/navigation'
import { AppMenu } from './AppMenu'
import { ComponentProps, ComponentType } from 'react'
import { cn } from '@repo/aui'
import { useLayoutStore } from '@/stores/layout.store'
import { MenuFoldOutlined, MenuUnfoldOutlined } from '@ant-design/icons'

export type AppHeaderProps = Partial<{} & ComponentProps<'div'>>

export const AppHeader = ({ className, ...props }: AppHeaderProps) => {
  const { adminInfo, authEnabled, clear } = useAuthStore()
  const { toggleSiderCollapsed, isSiderCollapsed } = useLayoutStore()
  const router = useRouter()
  const exit = async () => {
    clear()
    removeToken()
    await logoutAction()
    router.replace('/auth/login')
  }

  const handleDropdownClick: MenuProps['onClick'] = ({ key }) => {
    if (key === 'exit') exit()
    if (key === 'user-center') {
      router.push('/main/user-center')
    }
  }

  return (
    <div
      className={cn(
        'flex justify-between items-center h-16    px-5 bg-transparent',
        className,
      )}
      {...props}
    >
      <div className="flex gap-10 items-center">
        <div className="text-2xl ">{AppName}</div>
        <div
          className="cursor-pointer text-2xl hover:text-blue-400"
          onClick={toggleSiderCollapsed}
        >
          {isSiderCollapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
        </div>
      </div>

      {/* 用户体系开关关闭时隐藏用户下拉（无登录态） */}
      {authEnabled ? (
        <Dropdown
          menu={{
            onClick: handleDropdownClick,
            items: [
              { key: 'user-center', label: '个人中心' },
              { type: 'divider' },
              { key: 'exit', label: '退出' },
            ],
          }}
        >
          <div className=" cursor-pointer flex gap-2 items-center">
            {adminInfo?.avatar ? (
              <Avatar src={formatStorageUrl(adminInfo.avatar)} size="large" />
            ) : null}
            <div>{adminInfo?.realName || adminInfo?.email}</div>
            <DownOutlined />
          </div>
        </Dropdown>
      ) : null}
    </div>
  )
}
