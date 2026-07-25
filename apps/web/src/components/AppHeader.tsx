'use client'

import { AppName, formatStorageUrl } from '@/lib/constants'
import { useAuthStore } from '@/stores/auth.store'
import { logoutAction } from '@/actions/auth.actions'
import { authStorage } from '@/lib/auth'
import { DownOutlined } from '@ant-design/icons'
import { Avatar, Dropdown, MenuProps } from 'antd'
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
    if (key === 'user-center') {
      router.push('/main/user-center')
    }
  }

  return (
    <div className="flex justify-between items-center h-16  border-b  px-5">
      <div className="text-2xl ">{AppName}</div>

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
          {userInfo?.avatar ? (
            <Avatar src={formatStorageUrl(userInfo.avatar)} size="large" />
          ) : null}
          <div>{userInfo?.realName || userInfo?.email}</div>
          <DownOutlined />
        </div>
      </Dropdown>
    </div>
  )
}
