import type { ReactNode } from 'react'
import { AdminAuthBoundary } from '../../../../components/AdminAuthBoundary'
import { AppTopBar } from '../../../../components/AppTopBar'

/**
 * **全窗口画布布局**（技能编辑器用）。
 *
 * 与 `(standalone)`（AI 会话页）的区别：这里不套 `chat-type-scale` —— 会话页以 12px 为基准，
 * 而技能编辑器是"写文档"，需要正常字号与更松的行距。两棵树都复用同一份 `AdminAuthBoundary`。
 *
 * 顶栏也照挂（`AppTopBar`）：编辑器自己的页头只有"返回技能库"，没有顶层切换；
 * 不挂顶栏的话，从技能库点进编辑器之后就再也切不到会话页，只能按浏览器后退。
 *
 * 路由组不产生 URL 段：地址仍是 `/main/ai/skills/[skillKey]`，菜单 / 书签 / proxy 都不用动。
 */
export const dynamic = 'force-dynamic'

export default function CanvasLayout({ children }: { children: ReactNode }) {
  return (
    <AdminAuthBoundary>
      <div className="flex h-dvh w-screen flex-col overflow-clip bg-background">
        <AppTopBar />
        <div className="min-h-0 flex-1 overflow-clip">{children}</div>
      </div>
    </AdminAuthBoundary>
  )
}
