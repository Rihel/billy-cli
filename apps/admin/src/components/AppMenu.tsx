'use client'

import { usePathname, useRouter } from 'next/navigation'
import type { ComponentType } from 'react'
import {
  PlugIcon,
  BellRingIcon,
  BotIcon,
  ChartLineIcon,
  CpuIcon,
  FolderOpenIcon,
  GaugeIcon,
  HistoryIcon,
  LayoutDashboardIcon,
  RadioTowerIcon,
  ScrollTextIcon,
  ShieldCheckIcon,
  SparklesIcon,
  UsersIcon,
  WrenchIcon,
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

export const MENU_ITEMS: MenuItem[] = [
  {
    label: '控制台',
    key: '/main/dashboard',
    icon: LayoutDashboardIcon,
  },
  // AI：会话 / 运行的审计与复盘（只读，不提供删除 —— 运行与时间线是审计证据）
  {
    label: 'AI',
    key: 'ai',
    children: [
      { label: 'AI 会话', key: '/main/ai/chat', icon: BotIcon },
      { label: '模型管理', key: '/main/ai/models', icon: CpuIcon },
      { label: '工具配置', key: '/main/ai/tools', icon: WrenchIcon },
      { label: '技能库', key: '/main/ai/skills', icon: SparklesIcon },
      { label: '文件管理', key: '/main/ai/files', icon: FolderOpenIcon },
      { label: '连接器', key: '/main/ai/connectors', icon: PlugIcon },
      { label: '审计与复盘', key: '/main/ai/audit', icon: HistoryIcon },
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
        icon: ScrollTextIcon,
      },
      {
        label: '监控指标',
        key: '/main/monitor/metrics',
        icon: ChartLineIcon,
      },
      {
        label: '监控状态',
        key: '/main/monitor/status',
        icon: GaugeIcon,
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

/**
 * 路由 → 菜单标题：页头标题与侧栏菜单同源，避免两处手抄清单漂移
 * （新增页面只改 MENU_ITEMS，页头自动跟上）。详情页按路径前缀逐段回退到父级。
 */
export function menuTitleOf(pathname: string): string {
  const flat = MENU_ITEMS.flatMap((item) => (item.children ? item.children : [item]))
  const exact = flat.find((item) => item.key === pathname)
  if (exact) return exact.label

  const segments = pathname.split('/').filter(Boolean)
  while (segments.length > 1) {
    segments.pop()
    const key = `/${segments.join('/')}`
    const found = flat.find((item) => item.key === key)
    if (found) return found.label
  }
  return ''
}

export type AppMenuProps = Partial<{}>

export const AppMenu = (_props: AppMenuProps) => {
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
