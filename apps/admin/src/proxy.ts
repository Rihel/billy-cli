import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { Pages, PublicPaths, TokenKey } from './lib/constants'
import { createServerClient } from './lib/server-client'
import { logger } from './lib/logger'

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl
  const isPublic = PublicPaths.some((p) => pathname.startsWith(p))

  // 用户体系开关：调后端 /config/get 获取（关闭时跳过登录守卫，自用 / 外部认证场景）
  // 获取失败时保守按「开启」处理（守卫保持现状，不因配置获取失败而误放行）
  let authEnabled = true
  try {
    const config = await createServerClient().config.get()
    authEnabled = config.authEnabled
  } catch {
    // 保持默认开启
  }

  if (!authEnabled) {
    return NextResponse.next()
  }

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
  /**
   * 不经过登录守卫的路径。
   *
   * **图标必须在名单里**：`/icon.svg`、`/apple-icon.png`、`/opengraph-image` 是 Next 的
   * 元数据路由，未登录时同样会被浏览器请求 —— 被拦成 307 到登录页，表现是"图标/分享卡片静默不显示"
   * （浏览器不报错，只在网络面板里有一个 307）。`api` 与静态资源本来就在名单里。
   */
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|icon.svg|apple-icon.png|opengraph-image|twitter-image|api).*)',
  ],
}
