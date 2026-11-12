import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import type { ReactNode } from 'react'
import { Pages, TokenKey } from '@/lib/constants'
import { createServerClient } from '@/lib/server-client'
import { AuthStoreProvider } from '@/stores/auth.store'

/**
 * 管理台的**鉴权边界**（服务端组件）：取用户体系开关 → 校验管理员身份 → 把身份灌进客户端 store。
 *
 * 为什么抽成一份（而不是各布局自己写）：管理台外壳（`app/main/layout.tsx`）与**独立布局的
 * AI 会话页**（`app/(app)/(standalone)/main/layout.tsx`）是两棵不同的布局树，但**守卫只能有一份实现** ——
 * 复制一遍迟早会在"过期跳登录 / 关掉用户体系"这类分支上漂移，而漏掉守卫的后果是页面裸奔
 * （没有鉴权的管理台页面比样式问题严重得多）。
 *
 * 用法：外层布局直接把它套在 children 外面即可，**同时**记得在自己那个 layout 里导出
 * `export const dynamic = 'force-dynamic'`（它读 cookies，必须动态渲染）。
 */
export async function AdminAuthBoundary({ children }: { children: ReactNode }) {
  // 用户体系开关：调后端 /config/get 获取（关闭时跳过 getMe，自用 / 外部认证场景）
  // 获取失败时保守按「开启」处理（保持现有守卫行为）
  let authEnabled = true
  try {
    const config = await createServerClient().config.get()
    authEnabled = config.authEnabled
  } catch {
    // 保持默认开启
  }

  let adminInfo: Record<string, any> | null = null
  if (authEnabled) {
    const jar = await cookies()
    try {
      const client = createServerClient(jar.get(TokenKey)?.value)
      adminInfo = await client.admin.getMe()
    } catch {
      // 会话失效（过期 / 无效）时带 reason 跳转登录页，登录页据此提示重新登录
      redirect(`${Pages.login}?reason=expired`)
    }
  }

  return (
    <AuthStoreProvider initialState={{ adminInfo: adminInfo as any, authEnabled }}>
      {children}
    </AuthStoreProvider>
  )
}
