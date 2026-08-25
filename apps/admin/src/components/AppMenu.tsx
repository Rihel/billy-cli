'use client'

import { DashboardOutlined, UserOutlined } from '@ant-design/icons'
import { Menu, MenuProps } from 'antd'
import { usePathname, useRouter } from 'next/navigation'

export type AppMenuProps = Partial<{} & MenuProps>

export const AppMenu = ({ mode = 'inline', ...props }: AppMenuProps) => {
  const router = useRouter()
  const pathname = usePathname()
  const handleMenuClick: MenuProps['onClick'] = ({ key }) => {
    if (key) {
      router.push(key)
    }
  }
  const type = mode === 'inline' ? 'group' : 'submenu'
  return (
    <Menu
      theme="light"
      onClick={handleMenuClick}
      selectedKeys={[pathname]}
      classNames={{
        root: '!border-none !bg-transparent',
      }}
      mode={mode}
      items={[
        {
          label: '控制台',
          key: '/main/dashboard',
          icon: <DashboardOutlined />,
        },
        {
          label: '示例',
          type: type,
          key: 'demo',
          children: [
            {
              label: '任务管理',
              key: '/main/todo',
            },
            {
              label: '自动化',
              key: '/main/automation',
            },
          ],
        },
        {
          label: '系统设置',
          type: type,
          key: 'setting',
          children: [
            {
              label: '用户管理',
              key: '/main/system/users',
              icon: <UserOutlined />,
            },
          ],
        },
      ]}
      {...props}
    />
  )
}
