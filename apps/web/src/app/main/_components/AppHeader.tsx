'use client'

import { AppName } from '@/lib/constants'
import { useAuthStore } from '@/stores/auth.store'
import { logoutAction } from '@/actions/auth.actions'
import { authStorage } from '@/lib/auth'
import { DownOutlined } from '@ant-design/icons'
import { Dropdown, MenuProps } from 'antd'
import { Header } from 'antd/es/layout/layout'
import { useRouter } from 'next/navigation'

export type AppHeaderProps = Partial<{}>

export const AppHeader = ({}: AppHeaderProps) => {
  const { userInfo, clear } = useAuthStore()
  const router = useRouter()
  const exit = async () => {
    clear()
    authStorage.removeToken()
    await logoutAction()
    router.replace('/auth/login')
  }

  const handleDropdownClick: MenuProps['onClick'] = ({ key }) => {
    if (key === 'exit') exit()
  }

  return (
    <Header className="flex justify-between items-center">
      <div className="text-2xl text-white">{AppName}</div>

      <Dropdown
        menu={{
          onClick: handleDropdownClick,
          items: [{ type: 'divider' }, { key: 'exit', label: '退出' }],
        }}
      >
        <div className="text-white cursor-pointer flex gap-2">
          <div>{userInfo?.realName || userInfo?.email}</div>
          <DownOutlined />
        </div>
      </Dropdown>
    </Header>
  )
}
