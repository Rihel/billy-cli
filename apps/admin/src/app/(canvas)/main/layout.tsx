import type { ReactNode } from 'react'
import { AdminAuthBoundary } from '../../../components/AdminAuthBoundary'

/**
 * **全窗口画布布局**（技能编辑器用）。
 *
 * 与 `(standalone)`（AI 会话页）的区别：这里不套 `chat-type-scale` —— 会话页以 12px 为基准，
 * 而技能编辑器是"写文档"，需要正常字号与更松的行距。两棵树都复用同一份 `AdminAuthBoundary`。
 *
 * 路由组不产生 URL 段：地址仍是 `/main/ai/skills/[skillKey]`，菜单 / 书签 / proxy 都不用动。
 */
export const dynamic = 'force-dynamic'

export default function CanvasLayout({ children }: { children: ReactNode }) {
  return (
    <AdminAuthBoundary>
      <div className="h-screen w-screen overflow-clip bg-background">{children}</div>
    </AdminAuthBoundary>
  )
}
