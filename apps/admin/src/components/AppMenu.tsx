'use client'

import { usePathname, useRouter } from 'next/navigation'
import type { ComponentType } from 'react'
import {
  BoxesIcon,
  BellRingIcon,
  BrainIcon,
  ChartLineIcon,
  CpuIcon,
  FolderOpenIcon,
  GaugeIcon,
  HistoryIcon,
  KeyRoundIcon,
  LayoutDashboardIcon,
  RadioTowerIcon,
  ScrollTextIcon,
  ShieldCheckIcon,
  SparklesIcon,
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

export const MENU_ITEMS: MenuItem[] = [
  {
    label: '控制台',
    key: '/main/dashboard',
    icon: LayoutDashboardIcon,
  },
  // AI：配置面（模型 / 用量 / Key / 工具 / 技能 / 记忆 / 文件）与运行的审计复盘
  // （审计只读，不提供删除 —— 运行与时间线是审计证据）。
  // **不在这里放「AI 会话」**：会话是顶层分区（顶栏「会话」），侧栏这一组只放管理台的配置页，
  // 免得同一个目的地有两道门，还让人以为会话是"AI 配置"里的一项。
  {
    label: 'AI',
    key: 'ai',
    children: [
      { label: '模型管理', key: '/main/ai/models', icon: CpuIcon },
      { label: '网关用量', key: '/main/ai/usage', icon: ChartLineIcon },
      { label: '上游 Key', key: '/main/ai/keys', icon: KeyRoundIcon },
      { label: '技能库', key: '/main/ai/skills', icon: SparklesIcon },
      { label: '记忆', key: '/main/ai/memories', icon: BrainIcon },
      { label: '文件管理', key: '/main/ai/files', icon: FolderOpenIcon },
      { label: '能力服务', key: '/main/ai/capabilities', icon: BoxesIcon },
      { label: '服务授权', key: '/main/ai/authorizations', icon: ShieldCheckIcon },
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
