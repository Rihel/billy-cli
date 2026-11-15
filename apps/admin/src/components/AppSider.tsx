'use client'

import { Sidebar, SidebarContent } from '@repo/ui'
import { AppMenu } from './AppMenu'
import { TOP_BAR_HEIGHT } from './AppTopBar'

export type AppSiderProps = Partial<{}>

/**
 * **管理台侧栏**：只放模块菜单（品牌、账号都在全局顶栏 `AppTopBar` 里）。
 *
 * 为什么品牌与账号上移：顶栏是会话 / 管理**共用**的一条，品牌与账号只在那一处出现，
 * 免得"会话页没有侧栏、于是没有账号入口"这类分叉（那正是原来会话页要单独放一个
 * 「返回管理台」按钮的原因）。
 *
 * `style` 是给**共享 `Sidebar` 的 fixed 容器**用的：它默认 `inset-y-0 h-svh` 按视口铺满，
 * 顶栏横贯窗口最上方之后必须整体下移一个顶栏高度（行内样式比 `top-*` 类可靠 ——
 * 容器自带的 `inset-y-0` 与 `top-*` 是两个工具类，谁覆盖谁取决于产物里的声明顺序）。
 */
export const AppSider = (_props: AppSiderProps) => (
  <Sidebar
    collapsible="icon"
    variant="floating"
    className="p-3"
    style={{ top: TOP_BAR_HEIGHT, height: `calc(100svh - ${TOP_BAR_HEIGHT})` }}
  >
    <SidebarContent>
      <AppMenu />
    </SidebarContent>
  </Sidebar>
)
