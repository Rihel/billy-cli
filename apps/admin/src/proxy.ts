import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { Pages, PublicPaths, TokenKey } from './lib/constants'

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl
  const isPublic = PublicPaths.some((p) => pathname.startsWith(p))

  // token 只能在客户端 localStorage 读取，这里用 cookie 做 SSR 守卫：
  // 无 cookie 访问非公开页 → 登录页（登录页挂载时会探测会话有效性并清理失效 cookie）
  const token = request.cookies.get(TokenKey)?.value

  if (!isPublic && !token) {
    const loginUrl = new URL(Pages.login, request.url)
    return NextResponse.redirect(loginUrl)
  }

  return NextResponse.next()
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|api).*)'],
}
