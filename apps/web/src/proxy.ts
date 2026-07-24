import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { Pages, PublicPaths, TokenKey } from './lib/constants'

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl
  const isPublic = PublicPaths.some((p) => pathname.startsWith(p))

  // token 只能在客户端 localStorage 读取，这里用 cookie 做 SSR 守卫
  // 如果没有 cookie，重定向到登录页（客户端会在 Providers 里处理实际情况）
  const token = request.cookies.get(TokenKey)?.value

  if (!isPublic && !token) {
    const loginUrl = new URL(Pages.login, request.url)
    return NextResponse.redirect(loginUrl)
  }

  if (
    isPublic &&
    token &&
    ![Pages.forgotPassword, Pages.resetPassword].includes(pathname)
  ) {
    return NextResponse.redirect(new URL(Pages.dashboard, request.url))
  }

  return NextResponse.next()
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|api).*)'],
}
