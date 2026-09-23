'use client'

import { usePathname, useRouter } from 'next/navigation'
import type { ComponentType } from 'react'
import {
  ActivityIcon,
  BellRingIcon,
  BotIcon,
  CpuIcon,
  LayoutDashboardIcon,
  ListTodoIcon,
  RadioTowerIcon,
  ShieldCheckIcon,
  SparklesIcon,
  TerminalIcon,
  UsersIcon,
} from 'lucide-react'
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@repo/ui'
import { useAuthStore } from '@/stores/auth.store'

type MenuItem = {
  label: string
  key: string
  icon?: ComponentType<{ className?: string }>
  /** 用户体系开关关闭时隐藏（系统设置组） */
  authRequired?: boolean
  children?: MenuItem[]
}

const MENU_ITEMS: MenuItem[] = [
  {
    label: '控制台',
    key: '/main/dashboard',
    icon: LayoutDashboardIcon,
  },
  {
    label: '示例',
    key: 'demo',
    children: [
      { label: '任务管理', key: '/main/todo', icon: ListTodoIcon },
      { label: '自动化', key: '/main/automation', icon: TerminalIcon },
    ],
  },
  // AI：会话 / 运行的审计与复盘（只读，不提供删除 —— 运行与时间线是审计证据）
  {
    label: 'AI',
    key: 'ai',
    children: [
      { label: 'AI 会话', key: '/main/ai/chat', icon: BotIcon },
      { label: '模型管理', key: '/main/ai/models', icon: CpuIcon },
      { label: '审计与复盘', key: '/main/ai/audit', icon: SparklesIcon },
    ],
  },
  // 运维监控：独立于用户体系开关（监控告警为运维能力，始终可见）
  {
    label: '运维监控',
    key: 'monitor',
    children: [
      {
        label: '实时告警',
        key: '/main/monitor/live',
        icon: RadioTowerIcon,
      },
      {
        label: '告警规则',
        key: '/main/monitor/rules',
        icon: BellRingIcon,
      },
      {
        label: '告警记录',
        key: '/main/monitor/logs',
        icon: ActivityIcon,
      },
    ],
  },
  // 用户体系开关关闭时隐藏「系统设置」（用户 / 管理员管理）
  {
    label: '系统设置',
    key: 'setting',
    authRequired: true,
    children: [
      {
        label: '用户管理',
        key: '/main/system/users',
        icon: UsersIcon,
      },
      {
        label: '管理员管理',
        key: '/main/system/admins',
        icon: ShieldCheckIcon,
      },
    ],
  },
]

export type AppMenuProps = Partial<{}>

export const AppMenu = ({}: AppMenuProps) => {
  const router = useRouter()
  const pathname = usePathname()
  const authEnabled = useAuthStore((s) => s.authEnabled)

  const items = MENU_ITEMS.filter((item) => !item.authRequired || authEnabled)

  const go = (key: string) => {
    if (key.startsWith('/')) router.push(key)
  }

  return (
    <>
      {items.map((item) =>
        item.children ? (
          <SidebarGroup key={item.key} className="py-1.5">
            {/* 组标题：小号弱化标签（字距区分层级），降低高度让组更紧凑 */}
            <SidebarGroupLabel className="h-7 text-[11px] tracking-[0.08em] opacity-45">
              {item.label}
            </SidebarGroupLabel>
            {/* 项间距 8px，明显可辨 */}
            <SidebarMenu className="gap-2">
              {item.children.map((child) => {
                const Icon = child.icon
                return (
                  <SidebarMenuItem key={child.key}>
                    <SidebarMenuButton
                      isActive={pathname === child.key}
                      tooltip={child.label}
                      className="py-2"
                      onClick={() => go(child.key)}
                    >
                      {Icon ? <Icon /> : null}
                      <span>{child.label}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                )
              })}
            </SidebarMenu>
          </SidebarGroup>
        ) : (
          <SidebarGroup key={item.key} className="py-1.5">
            <SidebarMenu className="gap-2">
              <SidebarMenuItem>
                <SidebarMenuButton
                  isActive={pathname === item.key}
                  tooltip={item.label}
                  className="py-2"
                  onClick={() => go(item.key)}
                >
                  {item.icon ? <item.icon /> : null}
                  <span>{item.label}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroup>
        ),
      )}
    </>
  )
}
