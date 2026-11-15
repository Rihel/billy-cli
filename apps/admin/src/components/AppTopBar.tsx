'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import type { ComponentType } from 'react'
import {
  ChevronDownIcon,
  LayoutDashboardIcon,
  LogOutIcon,
  MessagesSquareIcon,
  TerminalSquareIcon,
  UserRoundIcon,
} from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  UserAvatar,
  cn,
  useStorageUrl,
} from '@repo/ui'
import { logoutAction } from '@/actions/auth.actions'
import { AppName, Pages } from '@/lib/constants'
import { removeToken } from '@/lib/server-client'
import { sectionOf, type AppSectionKey } from '@/lib/sections'
import { useAuthStore } from '@/stores/auth.store'
import { ThemeToggle } from './ThemeToggle'

/**
 * 顶栏高度（`3rem` = `h-12`）。
 *
 * 布局与侧栏共用这一个值：共享 `Sidebar` 的容器是 `fixed inset-y-0 h-svh`（按视口铺满），
 * 顶栏横贯在窗口最上方之后，它必须整体下移一个顶栏高度，否则会压在顶栏上。
 */
export const TOP_BAR_HEIGHT = '3rem'

type AppSection = {
  key: AppSectionKey
  label: string
  /** 该分区的落点地址（从别的分区切过来时进入这一页） */
  href: string
  icon: ComponentType<{ className?: string }>
}

/**
 * **顶层菜单**：只有两项，顺序即主次。
 *
 * - 「会话」是日常工作面（AI 对话工作台）—— 放在前、默认高亮的那一侧；
 * - 「管理」是配置面（控制台 / AI 配置 / 运维监控 / 系统设置），组内层级交给左侧菜单
 *   （`AppMenu` 的四组）表达，**不再往顶层拆**：拆成「监控」「系统」会变成五六个并列入口，
 *   每个都低频，反而让高频的会话更难找。
 *
 * 这条划分的依据是「谁天天用、谁偶尔用」：会话每天几十次，配置页一周几次。
 */
export const APP_SECTIONS: AppSection[] = [
  { key: 'chat', label: '会话', href: Pages.chat, icon: MessagesSquareIcon },
  { key: 'console', label: '管理', href: Pages.dashboard, icon: LayoutDashboardIcon },
]

export type AppTopBarProps = Partial<{ className: string }>

/**
 * **全局顶栏**（三棵布局树共用同一个组件：管理台 / 会话 / 技能画布）。
 *
 * 为什么抽成共享组件：管理台外壳（`app/(app)/main/layout.tsx`）与会话页的独立布局
 * （`app/(app)/(standalone)/main/layout.tsx`）是两棵树，但**顶层切换只能有一份实现** ——
 * 两处各写一遍，迟早会在"哪个算激活""切过去落在哪一页"上漂移。
 * 更关键的是：不共用的话，走进独立布局（会话 / 画布）就再也切不回管理台。
 *
 * 视觉分层（不画重边框）：品牌 + 顶层切换在左，主题与账号在右，底部一条发丝线
 * 与内容区分开；侧栏仍是悬浮卡（`variant="floating"`），悬在顶栏之下。
 */
export const AppTopBar = ({ className }: AppTopBarProps) => {
  const pathname = usePathname()
  const router = useRouter()
  const { adminInfo, authEnabled, clear } = useAuthStore()
  // 桶私有：头像 key 走短时预签名
  const avatarUrl = useStorageUrl(adminInfo?.avatar)

  const exit = async () => {
    // 先清本地状态，避免残留渲染
    clear()
    // 并行清理：localStorage token + 服务端会话撤销 + httpOnly cookie（任一失败不阻塞退出）
    await Promise.allSettled([removeToken(), logoutAction()])
    // 全量导航到登录页：新请求必然携带已删除的 cookie，绕开客户端路由缓存导致的旧 cookie 弹回
    window.location.href = Pages.login
  }

  const displayName = adminInfo?.realName || adminInfo?.email || '个人中心'
  const activeKey = sectionOf(pathname)

  return (
    <header
      className={cn(
        'flex shrink-0 items-center gap-3 border-b border-border/60 bg-background px-3',
        className,
      )}
      style={{ height: TOP_BAR_HEIGHT }}
    >
      {/* 品牌：点它回「管理」根（= `/` 的落点），与浏览器收藏 / 深链保持同一个口径 */}
      <Link
        href={Pages.dashboard}
        className="flex shrink-0 items-center gap-2 rounded-md focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-hidden"
      >
        <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-brand text-white">
          <TerminalSquareIcon className="size-4" strokeWidth={2.2} />
        </span>
        <span className="font-heading hidden text-[13px] font-semibold tracking-tight sm:block">
          {AppName}
        </span>
      </Link>

      <span aria-hidden className="h-4 w-px shrink-0 bg-border" />

      {/*
        顶层菜单用 `<Link>` 而不是 `SegmentedControl`：后者是**表单式单选组**（RadioGroup），
        拿来做导航会丢掉中键新开、右键复制地址、状态栏预览这些链接能力。
        视觉配方（`surface-3` 轨道 + 选中项品牌淡底）与它一致，只是换成链接语义。

        **当前分区不渲染成链接**：在「管理」里点「管理」不该被弹回控制台
        （可能正在填一张表单 / 停在某个详情页），在「会话」里点「会话」也不该中断当前会话
        —— 选中态就只是位置指示。
      */}
      <nav
        aria-label="顶层菜单"
        className="flex shrink-0 items-center gap-0.5 rounded-lg bg-surface-3 p-0.5"
      >
        {APP_SECTIONS.map((section) => {
          const active = section.key === activeKey
          const Icon = section.icon
          const itemClass = cn(
            'flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs transition-colors',
            active
              ? 'bg-brand/12 font-medium text-brand'
              : 'text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-hidden',
          )
          const content = (
            <>
              <Icon className="size-3.5" />
              {section.label}
            </>
          )
          return active ? (
            <span key={section.key} aria-current="page" className={itemClass}>
              {content}
            </span>
          ) : (
            <Link key={section.key} href={section.href} className={itemClass}>
              {content}
            </Link>
          )
        })}
      </nav>

      <div className="ml-auto flex shrink-0 items-center gap-1">
        <ThemeToggle />

        {authEnabled ? (
          <DropdownMenu>
            <DropdownMenuTrigger
              // 账号入口放在顶栏而不是侧栏底部：**会话树没有管理台侧栏**，
              // 放侧栏的话会话页就没有「个人中心 / 退出登录」的入口了
              render={
                <button
                  type="button"
                  className="flex h-8 items-center gap-1.5 rounded-md pr-1.5 pl-1 text-xs text-muted-foreground transition-colors hover:bg-surface-3 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-hidden"
                >
                  <UserAvatar
                    src={avatarUrl ?? null}
                    name={displayName}
                    size="sm"
                    shape="rounded"
                  />
                  <span className="hidden max-w-28 truncate sm:block">{displayName}</span>
                  <ChevronDownIcon className="size-3.5 shrink-0" />
                </button>
              }
            />
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuItem onClick={() => router.push('/main/user-center')}>
                <UserRoundIcon />
                个人中心
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onClick={() => void exit()}>
                <LogOutIcon />
                退出登录
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>
    </header>
  )
}
