import { Suspense } from 'react'
import type { ReactNode } from 'react'
import { AdminAuthBoundary } from '../../../../components/AdminAuthBoundary'

/**
 * **AI 会话页的独立布局**（只覆盖 `/main/ai/chat/**`）。
 *
 * 结构：放在路由组 `(standalone)` 下 —— 路由组**不产生 URL 段**，所以地址还是
 * `/main/ai/chat/...`（菜单、书签、proxy 匹配全不用动），但这一棵树**不再被管理台外壳包住**。
 *
 * 为什么独立：会话页是"全窗口工作台"。管理台外壳给的是左侧菜单 + 48px 页头，
 * 而会话页**自己已经有**页头（标题 / 模型选择 / 右栏开关）与会话列表栏 ——
 * 两层壳叠在一起，等于把最宝贵的竖直空间白送掉，也让"聊天"看着还像后台表单。
 *
 * 两条代价与补偿：
 * - **没有外壳导航**：页头提供「回管理台」入口（`chat-conversation.tsx` 的页头左侧）；
 * - **鉴权不能漏**：这里复用与管理台**同一份** `AdminAuthBoundary`（守卫只有一份实现），
 *   并且照旧导出 `dynamic = 'force-dynamic'`（它读 cookies）。
 *
 * 其余 AI 页面（`/main/ai/audit`、`/main/ai/models`、`/main/ai/tools`）是配置 / 审计类界面，
 * 仍然留在管理台外壳里 —— 那些页面确实需要左侧导航与页头标题。
 */
export const dynamic = 'force-dynamic'

export default function StandaloneAiLayout({ children }: { children: ReactNode }) {
  return (
    <AdminAuthBoundary>
      {/* `chat-type-scale`：会话页整棵子树的字号基准是 12px（见 app/globals.css 的说明） */}
      {/*
        根容器用 `overflow-clip` 而不是 `overflow-hidden`：
        hidden 会留下一个**可被程序滚动**的滚动容器（focus / scrollIntoView 能改 scrollTop，
        表现是"整页被顶上去一截"）；clip 根本不建立滚动容器，从结构上杜绝这种位移。
      */}
      <div className="chat-type-scale h-dvh w-screen overflow-clip bg-background">
        <Suspense>{children}</Suspense>
      </div>
    </AdminAuthBoundary>
  )
}
