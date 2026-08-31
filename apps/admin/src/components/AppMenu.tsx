'use client'

import {
  AlertOutlined,
  DashboardOutlined,
  SafetyOutlined,
  UserOutlined,
} from '@ant-design/icons'
import { Menu, MenuProps } from 'antd'
import { usePathname, useRouter } from 'next/navigation'
import { useAuthStore } from '@/stores/auth.store'

export type AppMenuProps = Partial<{} & MenuProps>

export const AppMenu = ({ mode = 'inline', ...props }: AppMenuProps) => {
  const router = useRouter()
  const pathname = usePathname()
  const authEnabled = useAuthStore((s) => s.authEnabled)
  const handleMenuClick: MenuProps['onClick'] = ({ key }) => {
    if (key) {
      router.push(key)
    }
  }
  const type = mode === 'inline' ? ('group' as const) : ('submenu' as const)
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
        // 运维监控：独立于用户体系开关（监控告警为运维能力，始终可见）
        {
          label: '运维监控',
          type: type,
          key: 'monitor',
          children: [
            {
              label: '告警规则',
              key: '/main/monitor/rules',
              icon: <AlertOutlined />,
            },
            {
              label: '告警记录',
              key: '/main/monitor/logs',
              icon: <AlertOutlined />,
            },
          ],
        },
        // 用户体系开关关闭时隐藏「系统设置」（用户 / 管理员管理）
        ...(authEnabled
          ? [
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
                  {
                    label: '管理员管理',
                    key: '/main/system/admins',
                    icon: <SafetyOutlined />,
                  },
                ],
              },
            ]
          : []),
      ]}
      {...props}
    />
  )
}
