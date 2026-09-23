import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { Pages, TokenKey } from './lib/constants'

/**
 * 受保护用户区（`/account`、`/ai`）的**边缘路由守卫**。
 *
 * 为什么不能只靠 `account/layout.tsx` 的 SSR 校验：根 layout 是 `force-dynamic` 且带 `<html>` 外壳，
 * 等嵌套 layout 抛 `redirect()` 时响应已开始流式输出 —— Next 只能把跳转意图塞进 RSC 负载
 * （HTTP 200 + 客户端跳转），拿不到真正的 307，禁用 JS 时也不会跳。守卫前移到中间件即可发出
 * 真正的 307，与 admin 的 `proxy.ts` 同一模式。
 *
 * 分工（两边都必要，不重复劳动）：
 * - 这里只查 **cookie 是否存在**（廉价、不请求后端）→ 没 cookie 直接 307 到登录页并带 `?next=`；
 * - 「cookie 存在但服务端会话已失效」由 layout 的 `getWebAuthState()` 调 `/auth/get-me` 判定后跳转。
 *
 * 用户体系开关（`AUTH_ENABLED=false`）**不在这里判断**：关掉时无账号概念，layout 会把人送回首页；
 * 在这里调后端配置会让每个受保护页请求都多一次网络往返。
 */
export function proxy(request: NextRequest) {
  const token = request.cookies.get(TokenKey)?.value
  if (token) return NextResponse.next()

  const loginUrl = new URL(Pages.login, request.url)
  loginUrl.searchParams.set('next', `${request.nextUrl.pathname}${request.nextUrl.search}`)
  return NextResponse.redirect(loginUrl)
}

export const config = {
  // 只挂受保护区（个人中心 + AI 会话）：首页 / auth / markdown 等页面完全不经过中间件（零额外开销）
  matcher: ['/account/:path*', '/ai/:path*'],
}
