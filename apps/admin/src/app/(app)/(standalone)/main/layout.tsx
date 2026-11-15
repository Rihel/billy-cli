import { Suspense } from 'react'
import type { ReactNode } from 'react'
import { AdminAuthBoundary } from '../../../../components/AdminAuthBoundary'
import { AppTopBar } from '../../../../components/AppTopBar'

/**
 * **AI 会话页的独立布局**（只覆盖 `/main/ai/chat/**`）。
 *
 * 结构：放在路由组 `(standalone)` 下 —— 路由组**不产生 URL 段**，所以地址还是
 * `/main/ai/chat/...`（菜单、书签、proxy 匹配全不用动），但这一棵树**不再被管理台外壳包住**
 * （没有左侧菜单、没有分区页头）。
 *
 * 为什么独立：会话页是"全窗口工作台"。管理台外壳给的是左侧菜单 + 页头，
 * 而会话页**自己已经有**页头（标题 / 模型选择 / 右栏开关）与会话列表栏 ——
 * 两层壳叠在一起，等于把最宝贵的竖直空间白送掉，也让"聊天"看着还像后台表单。
 *
 * **顶层导航靠共享顶栏 `AppTopBar`**：它横贯两棵树，"会话 / 管理"的切换因此在会话页上
 * 同样看得见、点得到 —— 不复用一条顶栏的话，这个独立布局就会变成一座孤岛
 * （原来只能靠列表栏里一个"返回管理台"按钮爬出去）。
 *
 * 鉴权不能漏：这里复用与管理台**同一份** `AdminAuthBoundary`（守卫只有一份实现），
 * 并且照旧导出 `dynamic = 'force-dynamic'`（它读 cookies）。
 */
export const dynamic = 'force-dynamic'

export default function StandaloneAiLayout({ children }: { children: ReactNode }) {
  return (
    <AdminAuthBoundary>
      <div className="flex h-dvh w-screen flex-col overflow-clip bg-background">
        <AppTopBar />
        {/* `chat-type-scale`：会话页整棵子树的字号基准是 12px（见 app/globals.css 的说明）。
         **只包内容区、不包顶栏** —— 顶栏是全局导航，跟管理台用同一套字号。 */}
        {/*
          内容容器用 `overflow-clip` 而不是 `overflow-hidden`：
          hidden 会留下一个**可被程序滚动**的滚动容器（focus / scrollIntoView 能改 scrollTop，
          表现是"整页被顶上去一截"）；clip 根本不建立滚动容器，从结构上杜绝这种位移。
        */}
        <div className="chat-type-scale min-h-0 flex-1 overflow-clip">
          <Suspense>{children}</Suspense>
        </div>
      </div>
    </AdminAuthBoundary>
  )
}
