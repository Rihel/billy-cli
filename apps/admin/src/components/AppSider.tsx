'use client'

import { useRouter } from 'next/navigation'
import { AppName, formatStorageUrl } from '@/lib/constants'
import { useAuthStore } from '@/stores/auth.store'
import { logoutAction } from '@/actions/auth.actions'
import { removeToken } from '@/lib/server-client'
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from '@repo/ui'
import { LogOutIcon, TerminalSquareIcon, UserRoundIcon } from 'lucide-react'
import { AppMenu } from './AppMenu'

export type AppSiderProps = Partial<{}>

export const AppSider = ({}: AppSiderProps) => {
  const { adminInfo, authEnabled, clear } = useAuthStore()
  const router = useRouter()

  const exit = async () => {
    // 先清本地状态，避免残留渲染
    clear()
    // 并行清理：localStorage token + 服务端会话撤销 + httpOnly cookie（任一失败不阻塞退出）
    await Promise.allSettled([removeToken(), logoutAction()])
    // 全量导航到登录页：新请求必然携带已删除的 cookie，绕开客户端路由缓存导致的旧 cookie 弹回
    window.location.href = '/auth/login'
  }

  const displayName = adminInfo?.realName || adminInfo?.email || '个人中心'
  const initial = displayName.charAt(0).toUpperCase()

  return (
    <Sidebar variant="floating" collapsible="icon">
      <SidebarHeader>
        {/* 品牌区：与前台一致的橙色渐变 TerminalSquare 方块 + 字标 + mono 副标 */}
        <div className="flex items-center gap-2.5 px-1 py-0.5">
          <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-gradient-to-br from-orange-500 to-orange-600 text-white shadow-md shadow-orange-500/25">
            <TerminalSquareIcon className="size-4" strokeWidth={2.2} />
          </span>
          <div className="flex min-w-0 flex-col leading-tight">
            <span className="truncate text-sm font-semibold tracking-tight">
              {AppName}
            </span>
            <span className="truncate font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
              admin console
            </span>
          </div>
        </div>
      </SidebarHeader>
      <SidebarContent>
        <AppMenu />
      </SidebarContent>

      {authEnabled ? (
        <SidebarFooter className="gap-2.5 pb-4">
          <SidebarMenu>
            <SidebarMenuItem>
              {/* 用户信息：鼠标悬停弹出菜单（个人中心 / 退出登录） */}
              <DropdownMenu>
                <DropdownMenuTrigger
                  openOnHover
                  delay={0}
                  render={
                    <SidebarMenuButton size="lg" className="py-2">
                      {adminInfo?.avatar ? (
                        <Avatar className="size-8 shrink-0 rounded-lg">
                          <AvatarImage src={formatStorageUrl(adminInfo.avatar)} />
                          <AvatarFallback className="rounded-lg">
                            {initial}
                          </AvatarFallback>
                        </Avatar>
                      ) : (
                        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-sm font-medium text-muted-foreground">
                          {initial}
                        </span>
                      )}
                      <span className="truncate">{displayName}</span>
                    </SidebarMenuButton>
                  }
                />
                <DropdownMenuContent
                  align="end"
                  side="right"
                  className="w-44"
                >
                  <DropdownMenuItem
                    onClick={() => router.push('/main/user-center')}
                  >
                    <UserRoundIcon />
                    个人中心
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    variant="destructive"
                    onClick={() => void exit()}
                  >
                    <LogOutIcon />
                    退出登录
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>
      ) : null}

      <SidebarRail />
    </Sidebar>
  )
}
