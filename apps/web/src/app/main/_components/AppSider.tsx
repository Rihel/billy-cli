'use client'
import { DashboardOutlined, UserOutlined } from '@ant-design/icons'
import { Menu, MenuProps } from 'antd'
import Sider from 'antd/es/layout/Sider'
import { usePathname, useRouter } from 'next/navigation'

export type AppSiderProps = Partial<{}>

export const AppSider = ({}: AppSiderProps) => {
  const router = useRouter()
  const pathname = usePathname()
  const handleMenuClick: MenuProps['onClick'] = ({ key }) => {
    if (key) {
      router.push(key)
    }
  }
  return (
    <Sider collapsible theme="light">
      <Menu
        theme="light"
        mode="inline"
        onClick={handleMenuClick}
        selectedKeys={[pathname]}
        items={[
          {
            label: '控制台',
            key: '/main/dashboard',
            icon: <DashboardOutlined />,
          },
          {
            label: '示例',
            type: 'group',
            children: [
              {
                label: '任务管理',
                key: '/main/todo',
              },
            ],
          },
          {
            label: '系统设置',
            type: 'group',

            children: [
              {
                label: '用户管理',
                key: '/main/system/users',
                icon: <UserOutlined />,
              },
            ],
          },
        ]}
      />
    </Sider>
  )
}
