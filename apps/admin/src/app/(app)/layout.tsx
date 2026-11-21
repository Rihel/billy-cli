import type { Metadata } from 'next'

import '../globals.css'
import 'react-grid-layout/css/styles.css'

import { createThemeBootScript } from '@repo/ui'
import { Providers } from '@/providers/AppProviders'
import { AppName, ThemeKey } from '@/lib/constants'
import { Suspense } from 'react'

/* 字体：**不接 next/font**，直接用 @repo/ui 定义的系统字体栈（2026-11-21 起）。
 * 原因：少一次外网字体下载（内网 / 离线部署更稳），且系统 UI 字体与中文本来就是同一套光学尺寸。
 * `pnpm check:ui` 会拦住任何 root layout 里的 `next/font/google`。 */
export const metadata: Metadata = {
  title: AppName,
  description: '超强脚手架',
}

/** 前端根 layout 统一动态渲染（每次请求 SSR，不做整站静态预渲染）。 */
export const dynamic = 'force-dynamic'

/**
 * 主题引导脚本（生成器在 `@repo/ui`）：在 React 水合前根据 localStorage / 系统偏好设置 .dark，
 * 避免深色模式刷新时白屏闪烁（FOUC）。key 用 admin 自己的，与前台互不干扰。
 */
const themeBootScript = createThemeBootScript({ storageKey: ThemeKey })

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="zh-CN">
      <body className="bg-background font-sans antialiased">
        <script dangerouslySetInnerHTML={{ __html: themeBootScript }} />
        <Providers>
          <Suspense>{children}</Suspense>
        </Providers>
      </body>
    </html>
  )
}
